// HA Energy Tile Card
const ENERGY_UNITS = {
  Wh: 1,
  kWh: 1000,
  MWh: 1000000,
};

const COLLECTION_RETRY_INTERVAL_MS = 500;
const MAX_COLLECTION_RETRIES = 20;
const STATISTICS_GENERATED_EVENT = "recorder_5min_statistics_generated";
const STATISTICS_HOURLY_PERIOD_MAX_DAYS = 2;
const STATISTICS_EVENT_REFRESH_DELAY_MS = 10000;
const DEBUG_RELATIVE_UPDATE_MS = 10000;
const ZERO_CONSUMPTION_EPSILON_KWH = 0.01;
const PRICE_UNIT_PATTERN = /^.+\/kWh$/i;
const PRICE_PER_KWH_UNITS = Object.freeze([
  "CHF/kWh",
  "EUR/kWh",
  "USD/kWh",
  "GBP/kWh",
  "AUD/kWh",
  "CAD/kWh",
  "DKK/kWh",
  "NOK/kWh",
  "SEK/kWh",
  "PLN/kWh",
  "CZK/kWh",
  "HUF/kWh",
  "RON/kWh",
  "JPY/kWh",
  "CNY/kWh",
  "INR/kWh",
  "BRL/kWh",
  "ZAR/kWh",
  "€/kWh",
  "£/kWh",
  "$/kWh",
  "ct/kWh",
  "c/kWh",
]);

function assertConfig(config) {
  if (
    !config ||
    typeof config.collection_key !== "string" ||
    !config.collection_key.startsWith("energy_")
  ) {
    throw new Error("collection_key is required and must start with energy_");
  }

  if (
    config.exclude_entities !== undefined &&
    !Array.isArray(config.exclude_entities)
  ) {
    throw new Error('"exclude_entities" must be an array');
  }
}

function isPricePerKWhUnit(unit) {
  return typeof unit === "string" && PRICE_UNIT_PATTERN.test(unit.trim());
}

function isEnergyUnit(unit) {
  return !!unit && unit in ENERGY_UNITS;
}

function convertEnergy(value, fromUnit, toUnit) {
  const from = ENERGY_UNITS[fromUnit];
  const to = ENERGY_UNITS[toUnit];
  if (from === undefined || to === undefined) return value;
  return (value * from) / to;
}

function hasPositiveConsumption(valueKWh) {
  return Number.isFinite(valueKWh) && valueKWh > ZERO_CONSUMPTION_EPSILON_KWH;
}

function findEnergyDataCollection(hass, collectionKey) {
  return hass?.connection?.[`_${collectionKey}`];
}

/**
 * The consumption of every sensor in one message. The recorder answers with the
 * rows of the requested period per sensor, so a sensor total is the sum of its
 * changes, the same reading the Energy dashboard applies to its own sensors.
 * Hourly rows up to two days and daily rows beyond follows that dashboard as
 * far as daily rows go and stops there: the answer stays small, and a month is
 * still read day by day rather than as one month row. Units are deliberately
 * not asked for: the sensor's own unit is what the card converts, and asking
 * the recorder to convert as well would convert twice.
 */
async function fetchStatisticTotals(hass, statisticIds, start, end) {
  const days = (end.getTime() - start.getTime()) / 86400000;

  const stats = await hass.callWS({
    type: "recorder/statistics_during_period",
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    statistic_ids: statisticIds,
    period: days > STATISTICS_HOURLY_PERIOD_MAX_DAYS ? "day" : "hour",
    types: ["change"],
  });

  return stats || {};
}

function periodContainsNow(start, end) {
  const now = Date.now();
  return start.getTime() <= now && end.getTime() >= now;
}

function formatDebugDateTime(hass, value) {
  if (!value) return "Not available";

  try {
    return new Intl.DateTimeFormat(getUserLanguage(hass), {
      dateStyle: "short",
      timeStyle: "medium",
    }).format(value);
  } catch (_) {
    return value.toISOString();
  }
}

function formatRelativeTime(hass, timestamp) {
  if (!timestamp) return "Never";

  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  let value = elapsedSeconds;
  let unit = "second";

  if (elapsedSeconds >= 86400) {
    value = Math.floor(elapsedSeconds / 86400);
    unit = "day";
  } else if (elapsedSeconds >= 3600) {
    value = Math.floor(elapsedSeconds / 3600);
    unit = "hour";
  } else if (elapsedSeconds >= 60) {
    value = Math.floor(elapsedSeconds / 60);
    unit = "minute";
  }

  try {
    return new Intl.RelativeTimeFormat(getUserLanguage(hass), {
      numeric: "auto",
    }).format(-value, unit);
  } catch (_) {
    return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  }
}

function configValueIsFalse(value) {
  if (typeof value === "string") {
    return ["false", "no", "off", "0"].includes(value.trim().toLowerCase());
  }
  return value === false || value === 0;
}

function normalizeConfig(config) {
  const displayUnit = config.display_unit || "kWh";

  if (!isEnergyUnit(displayUnit)) {
    throw new Error('display_unit must be "Wh", "kWh", or "MWh"');
  }

  const normalized = {
    ...config,
    debug: config.debug === true,
    display_unit: displayUnit,
    show_zero: !configValueIsFalse(config.show_zero),
    show_untracked: !configValueIsFalse(config.show_untracked),
  };
  delete normalized.entity;
  delete normalized.entities;
  delete normalized.include_all_energy;
  delete normalized.icon;
  return normalized;
}

function getUserLanguage(hass) {
  return (
    hass?.locale?.language ||
    hass?.language ||
    hass?.config?.language ||
    globalThis.navigator?.language ||
    "en"
  );
}

/**
 * The name of the row that carries what no listed sensor covers. Home Assistant
 * knows the language the user chose, so that row arrives in that language and
 * every language without an entry here reads English.
 */
const UNTRACKED_NAMES = {
  de: "Nicht erfasster Verbrauch",
  en: "Not captured consumption",
};

function getDefaultUntrackedName(hass) {
  const language = String(getUserLanguage(hass) || "en")
    .split("-")[0]
    .toLowerCase();

  return UNTRACKED_NAMES[language] || UNTRACKED_NAMES.en;
}

function getNumberLocale(hass) {
  const numberFormat = hass?.locale?.number_format;
  if (numberFormat === "comma_decimal") return "en-US";
  if (numberFormat === "decimal_comma") return "de-DE";
  if (numberFormat === "space_comma") return "fr-FR";
  if (numberFormat === "system") {
    return globalThis.navigator?.language || getUserLanguage(hass);
  }
  return getUserLanguage(hass);
}

function getNumberFormatOptions(hass) {
  return hass?.locale?.number_format === "none"
    ? { useGrouping: false }
    : {};
}

function getCurrency(hass, configuredCurrency) {
  return configuredCurrency || hass?.config?.currency || "USD";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fireEvent(node, type, detail = {}, options = {}) {
  node.dispatchEvent(
    new CustomEvent(type, {
      detail,
      bubbles: options.bubbles ?? true,
      cancelable: options.cancelable ?? false,
      composed: options.composed ?? true,
    })
  );
}

function normalizeListConfig(config, allowed, fallback) {
  const values = Array.isArray(config)
    ? config.map((entry) => (typeof entry === "string" ? entry : entry?.type))
    : typeof config === "string"
      ? [config]
      : fallback;

  const filtered = values.filter((entry) => allowed.includes(entry));
  return filtered.length ? filtered : fallback;
}

function getAreaId(hass, entityId) {
  const entity = hass.entities?.[entityId];
  if (!entity) return null;
  if (entity.area_id) return entity.area_id;

  const device = entity.device_id ? hass.devices?.[entity.device_id] : null;
  return device?.area_id || null;
}

function getDeviceName(hass, entityId) {
  const deviceId = hass.entities?.[entityId]?.device_id;
  const device = deviceId ? hass.devices?.[deviceId] : null;
  return device?.name_by_user || device?.name || "";
}

function getAreaName(hass, entityId) {
  const areaId = getAreaId(hass, entityId);
  return areaId ? hass.areas?.[areaId]?.name || "" : "";
}

function getFloorName(hass, entityId) {
  const areaId = getAreaId(hass, entityId);
  const floorId = areaId ? hass.areas?.[areaId]?.floor_id : null;
  return floorId ? hass.floors?.[floorId]?.name || "" : "";
}

function getEntityName(hass, entityId) {
  const stateObj = hass.states?.[entityId];
  if (stateObj && typeof hass.formatEntityName === "function") {
    const formatted = hass.formatEntityName(stateObj);
    if (formatted) return formatted;
  }
  const entity = hass.entities?.[entityId];
  return entity?.name || stateObj?.attributes?.friendly_name || entity?.original_name || entityId;
}

function namePart(hass, entityId, type) {
  if (type === "entity") return getEntityName(hass, entityId);
  if (type === "device") return getDeviceName(hass, entityId);
  if (type === "area") return getAreaName(hass, entityId);
  if (type === "floor") return getFloorName(hass, entityId);
  return "";
}

function buildName(hass, entityId, config) {
  const stateObj = hass.states?.[entityId];
  if (stateObj && typeof hass.formatEntityName === "function") {
    const formattedConfig = Array.isArray(config)
      ? config.map((entry) =>
          typeof entry === "string" ? { type: entry } : entry
        )
      : config;
    const formatted = hass.formatEntityName(stateObj, formattedConfig);
    if (formatted) return formatted;
  }
  return normalizeListConfig(config ?? "entity", ["entity", "area", "floor", "device"], ["entity"])
    .map((type) => namePart(hass, entityId, type))
    .filter(Boolean)
    .join(" • ");
}

function formatStateValue(value, unit, locale, numberFormatOptions = {}) {
  if (value === "unavailable" || value === "unknown" || value === "") return value;

  const numeric = parseFloat(value);
  if (!Number.isFinite(numeric)) return unit ? `${value} ${unit}` : value;

  const formatted = new Intl.NumberFormat(locale, {
    ...numberFormatOptions,
    maximumFractionDigits: Math.abs(numeric) >= 100 ? 1 : 2,
  }).format(numeric);

  return unit ? `${formatted} ${unit}` : formatted;
}

function stateContentPart(hass, entityId, type, locale, numberFormatOptions) {
  const stateObj = hass.states?.[entityId];
  if (!stateObj) return "";

  if (type === "device_name") return getDeviceName(hass, entityId);
  if (type === "area_name") return getAreaName(hass, entityId);
  if (type === "floor_name") return getFloorName(hass, entityId);
  if (type === "last_changed" || type === "last_updated") {
    const value = stateObj[type];
    if (!value) return "";
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: hass.config?.time_zone,
    }).format(new Date(value));
  }
  if (type === "state") {
    if (typeof hass.formatEntityState === "function") {
      const formatted = hass.formatEntityState(stateObj);
      if (formatted) return formatted;
    }
    return formatStateValue(
      stateObj.state,
      stateObj.attributes?.unit_of_measurement,
      locale,
      numberFormatOptions
    );
  }

  if (typeof hass.formatEntityAttributeValue === "function") {
    const formatted = hass.formatEntityAttributeValue(stateObj, type);
    if (formatted) return formatted;
  }

  const attribute = stateObj.attributes?.[type];
  if (attribute !== undefined && attribute !== null) return String(attribute);

  return "";
}

function buildStateContent(hass, entityId, config, locale, numberFormatOptions) {
  const content = Array.isArray(config)
    ? config.map((entry) =>
        typeof entry === "string" ? entry : entry?.type || entry?.attribute
      )
    : typeof config === "string"
      ? [config]
      : ["state"];

  return content
    .filter(Boolean)
    .map((type) =>
      stateContentPart(hass, entityId, type, locale, numberFormatOptions)
    )
    .filter(Boolean)
    .join(" · ");
}

function isHiddenEntity(hass, entityId) {
  const entity = hass.entities?.[entityId];
  return !!(entity?.hidden || entity?.hidden_by);
}

function isEnergySensor(hass, entityId) {
  const stateObj = hass.states?.[entityId];
  if (!stateObj || !entityId.startsWith("sensor.")) return false;

  const attributes = stateObj.attributes || {};
  const stateClass = attributes.state_class;

  return (
    attributes.device_class === "energy" &&
    isEnergyUnit(attributes.unit_of_measurement) &&
    (!stateClass || stateClass === "total" || stateClass === "total_increasing")
  );
}

function getVisibleEnergySensors(hass) {
  return Object.keys(hass.states || {})
    .filter((entityId) => isEnergySensor(hass, entityId))
    .filter((entityId) => !isHiddenEntity(hass, entityId))
    .sort((a, b) => a.localeCompare(b));
}

function getCurrentPrice(hass, priceEntity) {
  if (!priceEntity) return null;

  const stateObj = hass.states?.[priceEntity];
  if (!stateObj) return null;
  if (!isPricePerKWhUnit(stateObj.attributes?.unit_of_measurement)) return null;

  const price = parseFloat(stateObj.state);
  return Number.isFinite(price) ? price : null;
}

function sumStatisticChanges(stats) {
  if (!Array.isArray(stats)) return 0;

  return stats.reduce((sum, stat) => {
    const change = Number(stat?.change);
    return Number.isFinite(change) ? sum + change : sum;
  }, 0);
}

/**
 * Total energy the household used during the selected period, in kWh, the same
 * way the Energy dashboard itself derives it: the configured home meter when
 * there is one, otherwise the grid import plus solar and battery discharge that
 * stayed in the house. Returns null when the collection carries no such
 * sources, which leaves the card without a house total.
 */
function computeCollectionHouseConsumptionKWh(data) {
  const sources = data?.prefs?.energy_sources;
  if (!Array.isArray(sources) || !data.stats) return null;

  const homeStats = sources
    .filter((source) => source?.type === "home")
    .map((source) => source.stat_energy_to);

  if (homeStats.length) {
    const home = homeStats.reduce(
      (sum, statId) => sum + sumStatisticChanges(data.stats[statId]),
      0
    );
    return home > 0 ? home : null;
  }

  let fromGrid = 0;
  let toGrid = 0;
  let solar = 0;
  let batteryCharge = 0;
  let batteryDischarge = 0;

  for (const source of sources) {
    if (source?.type === "grid") {
      fromGrid += sumStatisticChanges(data.stats[source.stat_energy_from]);
      toGrid += sumStatisticChanges(data.stats[source.stat_energy_to]);
      continue;
    }

    if (source?.type === "solar") {
      solar += sumStatisticChanges(data.stats[source.stat_energy_from]);
      continue;
    }

    if (source?.type === "battery") {
      // A battery is metered either by direction or by totals, never both.
      const chargeStats = [
        source.stat_energy_to,
        source.stat_energy_from_grid,
        source.stat_energy_from_solar,
      ];
      const dischargeStats = [
        source.stat_energy_from,
        source.stat_energy_to_home,
      ];
      batteryCharge += chargeStats.reduce(
        (sum, statId) => sum + sumStatisticChanges(data.stats[statId]),
        0
      );
      batteryDischarge += dischargeStats.reduce(
        (sum, statId) => sum + sumStatisticChanges(data.stats[statId]),
        0
      );
      continue;
    }
  }

  if (!fromGrid && !solar && !batteryDischarge) return null;

  const total = fromGrid + solar + batteryDischarge - toGrid - batteryCharge;
  return total > 0 ? total : null;
}

/** Point on a circle, measured from the top and turning clockwise. */
function polarPoint(cx, cy, radius, degrees) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [
    (cx + radius * Math.cos(radians)).toFixed(2),
    (cy + radius * Math.sin(radians)).toFixed(2),
  ];
}

/**
 * Arc of a donut ring between two percentages. Each tile ring starts where the
 * previous one ended, so the rings of the list fill one shared circle.
 */
function describeDonutArc(cx, cy, radius, startPercent, endPercent) {
  const start = Math.max(0, Math.min(100, startPercent));
  const end = Math.max(start, Math.min(100, endPercent));
  if (end - start < 0.1) return "";

  const sweep = Math.min(end - start, 100 - 0.05);
  const from = polarPoint(cx, cy, radius, (start / 100) * 360);
  const to = polarPoint(cx, cy, radius, ((start + sweep) / 100) * 360);

  return `M ${from[0]} ${from[1]} A ${radius} ${radius} 0 ${
    sweep > 50 ? 1 : 0
  } 1 ${to[0]} ${to[1]}`;
}

class HaEnergyTileCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._hass = undefined;
    this._config = undefined;
    this._items = [];
    this._rows = [];
    this._warnings = [];
    this._error = null;
    this._loading = true;

    this._collectionStart = undefined;
    this._collectionEnd = undefined;
    this._houseTotalKWh = null;
    this._collectionUnsubscribe = undefined;
    this._collectionRetryTimer = undefined;
    this._collectionRetryCount = 0;
    this._subscribedCollectionKey = undefined;
    this._subscribedCollection = undefined;
    this._statisticsSubscriptionConnection = undefined;
    this._statisticsSubscriptionPending = false;
    this._statisticsSubscriptionId = 0;
    this._statisticsUnsubscribe = undefined;
    this._statisticsRefreshTimer = undefined;
    this._lastStatisticsEvent = undefined;
    this._debugUpdateTimer = undefined;

    this._fetchInFlight = false;
    this._pendingFetch = false;
    this._lastFetchKey = "";
    this._resolvedEntities = [];

    this._onClick = this._onClick.bind(this);
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;

    this._setupEnergyCollection();
    this._setupStatisticsSubscription();

    if (firstHass && this._config) {
      this._render();
    }

    this._maybeFetch();
  }

  get hass() {
    return this._hass;
  }

  setConfig(config) {
    assertConfig(config);
    this._config = normalizeConfig(config);
    this._items = [];
    this._rows = [];
    this._warnings = [];
    this._error = null;
    this._loading = true;
    this._houseTotalKWh = null;
    this._lastFetchKey = "";

    this._setupEnergyCollection();
    this._render();
    this._maybeFetch();
  }

  connectedCallback() {
    this.shadowRoot?.addEventListener("click", this._onClick);
    this._setupEnergyCollection();
    this._setupStatisticsSubscription();
    this._render();
    this._maybeFetch();
  }

  disconnectedCallback() {
    this.shadowRoot?.removeEventListener("click", this._onClick);

    this._collectionUnsubscribe?.();
    this._collectionUnsubscribe = undefined;
    this._subscribedCollectionKey = undefined;
    this._subscribedCollection = undefined;
    this._clearStatisticsSubscription();
    this._clearDebugTimer();

    if (this._collectionRetryTimer !== undefined) {
      window.clearTimeout(this._collectionRetryTimer);
      this._collectionRetryTimer = undefined;
    }
  }

  _onClick(event) {
    const card = event.target?.closest?.("ha-card[data-entity]");
    if (card) this._handleTap(card.dataset.entity);
  }

  _clearDebugTimer() {
    if (this._debugUpdateTimer === undefined) return;
    window.clearTimeout(this._debugUpdateTimer);
    this._debugUpdateTimer = undefined;
  }

  _scheduleDebugUpdate() {
    this._clearDebugTimer();
    if (!this._config?.debug || !this._lastStatisticsEvent) return;

    this._debugUpdateTimer = window.setTimeout(() => {
      this._debugUpdateTimer = undefined;
      this._updateDebugLastEvent();
      this._scheduleDebugUpdate();
    }, DEBUG_RELATIVE_UPDATE_MS);
  }

  _updateDebugLastEvent() {
    const value = this.shadowRoot?.querySelector?.("#debug-last-event");
    if (value) {
      value.textContent = formatRelativeTime(
        this.hass,
        this._lastStatisticsEvent
      );
    }
  }

  _clearStatisticsSubscription() {
    this._statisticsSubscriptionId += 1;
    if (this._statisticsRefreshTimer !== undefined) {
      window.clearTimeout(this._statisticsRefreshTimer);
      this._statisticsRefreshTimer = undefined;
    }
    this._statisticsUnsubscribe?.();
    this._statisticsUnsubscribe = undefined;
    this._statisticsSubscriptionConnection = undefined;
    this._statisticsSubscriptionPending = false;
  }

  _setupStatisticsSubscription() {
    const connection = this.hass?.connection;
    if (
      !connection?.subscribeEvents ||
      (this._statisticsSubscriptionConnection === connection &&
        (this._statisticsUnsubscribe || this._statisticsSubscriptionPending))
    ) {
      return;
    }

    this._clearStatisticsSubscription();
    this._statisticsSubscriptionConnection = connection;
    this._statisticsSubscriptionPending = true;
    const subscriptionId = this._statisticsSubscriptionId;

    Promise.resolve(
      connection.subscribeEvents((event) => {
        const eventTimestamp = Date.parse(event?.time_fired);
        this._lastStatisticsEvent = Number.isFinite(eventTimestamp)
          ? eventTimestamp
          : Date.now();
        this._updateDebugLastEvent();
        this._scheduleDebugUpdate();

        if (
          subscriptionId !== this._statisticsSubscriptionId ||
          !this._collectionStart ||
          !this._collectionEnd ||
          !periodContainsNow(this._collectionStart, this._collectionEnd)
        ) {
          return;
        }

        if (this._statisticsRefreshTimer !== undefined) {
          window.clearTimeout(this._statisticsRefreshTimer);
        }

        this._statisticsRefreshTimer = window.setTimeout(() => {
          this._statisticsRefreshTimer = undefined;
          if (
            subscriptionId !== this._statisticsSubscriptionId ||
            !this._collectionStart ||
            !this._collectionEnd ||
            !periodContainsNow(this._collectionStart, this._collectionEnd)
          ) {
            return;
          }

          this._lastFetchKey = "";
          this._maybeFetch();
        }, STATISTICS_EVENT_REFRESH_DELAY_MS);
      }, STATISTICS_GENERATED_EVENT)
    )
      .then((unsubscribe) => {
        if (subscriptionId !== this._statisticsSubscriptionId) {
          unsubscribe?.();
          return;
        }

        this._statisticsSubscriptionPending = false;
        this._statisticsUnsubscribe = unsubscribe;
        if (this._config?.debug) this._render();
      })
      .catch((error) => {
        if (subscriptionId !== this._statisticsSubscriptionId) return;
        this._statisticsSubscriptionPending = false;
        this._statisticsSubscriptionConnection = undefined;
        if (this._config?.debug) this._render();
        console.warn(
          "[ha_energy-tile-card] Statistics event subscription failed",
          error
        );
      });
  }

  _setupEnergyCollection() {
    if (!this.hass || !this._config?.collection_key) return;

    if (this._collectionRetryTimer !== undefined) {
      window.clearTimeout(this._collectionRetryTimer);
      this._collectionRetryTimer = undefined;
    }

    const collectionKey = this._config.collection_key;
    const collection = findEnergyDataCollection(this.hass, collectionKey);

    if (!collection) {
      this._collectionRetryCount += 1;

      if (this._collectionRetryCount > MAX_COLLECTION_RETRIES) {
        this._error = `Energy collection "${collectionKey}" was not found`;
        this._loading = false;
        this._render();
        return;
      }

      this._collectionRetryTimer = window.setTimeout(
        () => this._setupEnergyCollection(),
        COLLECTION_RETRY_INTERVAL_MS
      );
      return;
    }

    this._collectionRetryCount = 0;

    if (
      this._subscribedCollectionKey === collectionKey &&
      this._subscribedCollection === collection
    ) {
      return;
    }

    this._collectionUnsubscribe?.();
    this._collectionUnsubscribe = undefined;
    this._subscribedCollectionKey = collectionKey;
    this._subscribedCollection = collection;

    const applyData = (data) => {
      const start = data?.start || collection.start;
      const end = data?.end || collection.end || new Date();
      if (!start || !end) return;

      const houseTotalKWh = computeCollectionHouseConsumptionKWh(data);
      if (houseTotalKWh !== this._houseTotalKWh) {
        this._houseTotalKWh = houseTotalKWh;
        this._applyShares();
        this._render();
      }

      const startDate = new Date(start);
      const endDate = new Date(end);

      const changed =
        !this._collectionStart ||
        !this._collectionEnd ||
        this._collectionStart.getTime() !== startDate.getTime() ||
        this._collectionEnd.getTime() !== endDate.getTime();

      if (!changed) return;

      this._collectionStart = startDate;
      this._collectionEnd = endDate;
      this._lastFetchKey = "";
      this._maybeFetch();
    };

    applyData(collection);

    if (typeof collection.subscribe === "function") {
      this._collectionUnsubscribe = collection.subscribe(applyData);
    }
  }

  _getActivePeriodRange() {
    if (!this._collectionStart || !this._collectionEnd) {
      throw new Error("Energy date selection is not ready yet");
    }

    const start = new Date(this._collectionStart);
    const end = new Date(this._collectionEnd);

    return {
      start,
      end,
    };
  }

  _getEntities() {
    if (!this._config || !this.hass) return [];

    const excluded = new Set(this._config.exclude_entities || []);
    return getVisibleEnergySensors(this.hass).filter(
      (entityId) => !excluded.has(entityId)
    );
  }

  _buildFetchKey(entityIds) {
    return [
      entityIds.join(","),
      this._collectionStart?.toISOString() || "",
      this._collectionEnd?.toISOString() || "",
    ].join("|");
  }

  _maybeFetch() {
    if (!this.hass || !this._config || !this._collectionStart || !this._collectionEnd) return;

    const entityIds = this._getEntities();
    this._resolvedEntities = entityIds;

    const key = this._buildFetchKey(entityIds);
    if (key === this._lastFetchKey) return;

    if (this._fetchInFlight) {
      this._pendingFetch = true;
      return;
    }

    this._lastFetchKey = key;
    this._fetchData(entityIds, key);
  }

  async _fetchData(entityIds, fetchKey) {
    const initialLoad = this._items.length === 0;

    this._fetchInFlight = true;
    this._loading = initialLoad;
    this._error = null;
    this._warnings = [];

    if (initialLoad) this._render();

    try {
      const period = this._getActivePeriodRange();
      const validEntities = this._validateEntities(entityIds);

      if (validEntities.length === 0) {
        throw new Error("No valid energy entities were found");
      }

      const stats = await fetchStatisticTotals(
        this.hass,
        validEntities,
        period.start,
        period.end
      );

      if (fetchKey !== this._lastFetchKey) return;

      this._buildItems(validEntities, stats);
    } catch (error) {
      this._error = error instanceof Error ? error.message : "Unknown error";
      this._items = [];
      this._rows = [];
      console.error("[ha_energy-tile-card]", error);
    } finally {
      this._fetchInFlight = false;
      this._loading = false;
      this._render();

      if (this._pendingFetch) {
        this._pendingFetch = false;
        this._lastFetchKey = "";
        this._maybeFetch();
      }
    }
  }

  _validateEntities(entityIds) {
    const validEntities = [];
    const warnings = [];

    if (entityIds.length === 0) {
      warnings.push("No entities are configured");
    }

    if (this._config.price_entity) {
      const priceState = this.hass.states?.[this._config.price_entity];
      if (!priceState) {
        warnings.push(`Price entity ${this._config.price_entity} was not found`);
      } else if (
        !isPricePerKWhUnit(priceState.attributes?.unit_of_measurement)
      ) {
        warnings.push(
          `${this._config.price_entity} was ignored — its unit must end in /kWh`
        );
      }
    }

    for (const entityId of entityIds) {
      const stateObj = this.hass.states?.[entityId];

      if (!stateObj) {
        warnings.push(`Entity ${entityId} was not found`);
        continue;
      }

      const stateClass = stateObj.attributes?.state_class;
      const unit = stateObj.attributes?.unit_of_measurement;

      if (!isEnergyUnit(unit) || (stateClass && stateClass !== "total" && stateClass !== "total_increasing")) {
        warnings.push(
          `${entityId} was skipped — only energy sensors using Wh, kWh, or MWh with state_class total/total_increasing are supported`
        );
        continue;
      }

      validEntities.push(entityId);
    }

    this._warnings = warnings;
    return validEntities;
  }

  _getConsumptionKWh(entityId, stats) {
    const stateObj = this.hass.states?.[entityId];
    const unit = stateObj?.attributes?.unit_of_measurement;
    const consumption = sumStatisticChanges(stats[entityId]);
    return convertEnergy(consumption, unit, "kWh");
  }

  _buildItems(entityIds, stats) {
    const currentPrice = getCurrentPrice(this.hass, this._config.price_entity);
    const displayUnit = this._config.display_unit;

    let items = entityIds.map((entityId) => {
      const consumptionKWh = this._getConsumptionKWh(entityId, stats);

      return {
        entity: entityId,
        consumptionKWh,
        consumption: convertEnergy(consumptionKWh, "kWh", displayUnit),
        displayUnit,
        cost: currentPrice === null ? null : consumptionKWh * currentPrice,
        percentage: null,
      };
    });

    if (!this._config.show_zero) {
      items = items.filter((item) => hasPositiveConsumption(item.consumptionKWh));
    }

    this._items = items.sort((a, b) => b.consumptionKWh - a.consumptionKWh);
    return this._applyShares();
  }

  /**
   * Every share is taken against the whole house, not against the list, and
   * each ring starts where the previous one ended, so the rings of all rows
   * build one circle. The house total comes from the Energy collection that
   * also defines the period; what its sources do not account for becomes a
   * single "not captured" row. Without a house total the circle can only be
   * the list itself, and the extra row would always be empty.
   */
  _applyShares() {
    const listTotalKWh = this._items.reduce(
      (sum, item) => sum + Math.max(0, item.consumptionKWh),
      0
    );
    const houseTotalKWh =
      Number.isFinite(this._houseTotalKWh) && this._houseTotalKWh > 0
        ? this._houseTotalKWh
        : null;
    const baseKWh =
      houseTotalKWh === null
        ? listTotalKWh
        : Math.max(houseTotalKWh, listTotalKWh);

    let cursor = 0;
    for (const item of this._items) {
      const share =
        baseKWh > 0
          ? Math.max(0, Math.min(100, (item.consumptionKWh / baseKWh) * 100))
          : null;

      item.percentage = share;
      item.arcStart = share === null ? null : cursor;
      cursor += share || 0;
      item.arcEnd = share === null ? null : cursor;
    }

    const rows = [...this._items];
    const untrackedKWh =
      houseTotalKWh === null ? 0 : Math.max(0, baseKWh - listTotalKWh);

    if (
      this._config?.show_untracked &&
      untrackedKWh > ZERO_CONSUMPTION_EPSILON_KWH
    ) {
      const currentPrice = getCurrentPrice(this.hass, this._config.price_entity);

      rows.push({
        entity: null,
        untracked: true,
        consumptionKWh: untrackedKWh,
        consumption: convertEnergy(
          untrackedKWh,
          "kWh",
          this._config.display_unit
        ),
        displayUnit: this._config.display_unit,
        cost: currentPrice === null ? null : untrackedKWh * currentPrice,
        percentage: 100 - cursor,
        arcStart: cursor,
        arcEnd: 100,
      });
    }

    this._rows = rows;
    return rows;
  }

  _formatCost(value, currency, locale, numberFormatOptions) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        ...numberFormatOptions,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch (_) {
      return `${new Intl.NumberFormat(locale, {
        ...numberFormatOptions,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)} ${currency}`;
    }
  }

  _formatEnergy(value, unit, locale, numberFormatOptions) {
    const abs = Math.abs(value);
    const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;

    return `${new Intl.NumberFormat(locale, {
      ...numberFormatOptions,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value)} ${unit}`;
  }

  _handleTap(entityId) {
    const action = this._config?.tap_action?.action ?? "more-info";
    if (action === "none") return;

    if (action === "more-info" && entityId) {
      fireEvent(this, "hass-more-info", { entityId });
    }
  }

  _renderWarnings() {
    if (!this._warnings.length) return "";

    return `
      <ha-card>
        <div class="warning">
          <ha-icon icon="mdi:alert-outline"></ha-icon>
          <div class="warning-list">
            ${this._warnings.map((warning) => `<span>${escapeHtml(warning)}</span>`).join("")}
          </div>
        </div>
      </ha-card>
    `;
  }

  _renderDebug() {
    if (!this._config?.debug) return "";

    const subscriptionStatus = this._statisticsUnsubscribe
      ? "Subscribed"
      : this._statisticsSubscriptionPending
        ? "Pending"
        : "Not subscribed";
    const rangeStart = formatDebugDateTime(this.hass, this._collectionStart);
    const rangeEnd = formatDebugDateTime(this.hass, this._collectionEnd);
    const houseTotal = Number.isFinite(this._houseTotalKWh)
      ? `${this._houseTotalKWh.toFixed(2)} kWh`
      : "Not available — shares are taken against the listed sensors";

    return `
      <ha-card class="debug-card">
        <div class="debug-grid">
          <span class="debug-label">Data source</span>
          <code>recorder/statistics_during_period</code>
          <span class="debug-label">From</span>
          <span>${escapeHtml(rangeStart)}</span>
          <span class="debug-label">To</span>
          <span>${escapeHtml(rangeEnd)}</span>
          <span class="debug-label">House total</span>
          <span>${escapeHtml(houseTotal)}</span>
          <span class="debug-label">Subscription</span>
          <span>${escapeHtml(subscriptionStatus)}</span>
          <span class="debug-label">Last event</span>
          <span id="debug-last-event">${escapeHtml(
            formatRelativeTime(this.hass, this._lastStatisticsEvent)
          )}</span>
        </div>
      </ha-card>
    `;
  }

  _formatShare(percentage, locale, numberFormatOptions) {
    if (percentage === null || percentage === undefined) return "";

    try {
      return new Intl.NumberFormat(locale, {
        ...numberFormatOptions,
        style: "percent",
        minimumFractionDigits: 0,
        maximumFractionDigits: 1,
      }).format(percentage / 100);
    } catch (_) {
      return `${percentage.toFixed(0)} %`;
    }
  }

  _renderRing(item, index) {
    const size = 34;
    const stroke = 9;
    const center = size / 2;
    const radius = (size - stroke) / 2;
    const share = item.percentage === null ? null : Math.round(item.percentage);
    const base =
      Number.isFinite(this._houseTotalKWh) && this._houseTotalKWh > 0
        ? "the house consumption"
        : "the listed sensors";

    let svg = `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeHtml(
      share === null ? "No share" : `${share}% of ${base}`
    )}">`;
    svg += `<circle class="ring-track" cx="${center}" cy="${center}" r="${radius}" stroke-width="${stroke}" fill="none"></circle>`;

    this._rows.forEach((row, rowIndex) => {
      const path = describeDonutArc(
        center,
        center,
        radius,
        row.arcStart ?? 0,
        row.arcEnd ?? 0
      );
      if (!path) return;

      const role = row.untracked
        ? "ring-untracked"
        : rowIndex === index
          ? "ring-current"
          : "ring-past";
      svg += `<path class="ring-segment ${role}" d="${path}" fill="none" stroke-width="${stroke}"></path>`;
    });

    return `${svg}</svg>`;
  }

  _renderEntityTile(item, index, locale, currency, numberFormatOptions) {
    const entityId = item.entity;
    const name = item.untracked
      ? this._config.untracked_name || getDefaultUntrackedName(this.hass)
      : buildName(this.hass, entityId, this._config.name);
    const secondary = item.untracked
      ? this._formatShare(item.percentage, locale, numberFormatOptions)
      : buildStateContent(
          this.hass,
          entityId,
          this._config.state_content,
          locale,
          numberFormatOptions
        );

    const cost =
      item.cost !== null && item.cost !== undefined
        ? this._formatCost(item.cost, currency, locale, numberFormatOptions)
        : "";

    const consumption = this._formatEnergy(
      item.consumption,
      item.displayUnit,
      locale,
      numberFormatOptions
    );
    const clickable =
      !item.untracked &&
      (this._config?.tap_action?.action ?? "more-info") !== "none";

    return `
      <ha-card class="entity-card${clickable ? " clickable" : ""}${
        item.untracked ? " untracked" : ""
      }"${item.untracked ? "" : ` data-entity="${escapeHtml(entityId)}"`}>
        <div class="container entity-row">
          <div class="ring-wrapper">${this._renderRing(item, index)}</div>

          <div class="info">
            <div class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
            ${secondary ? `<div class="secondary" title="${escapeHtml(secondary)}">${escapeHtml(secondary)}</div>` : ""}
          </div>

          <div class="values">
            <div class="consumption">${escapeHtml(consumption)}</div>
            ${cost ? `<div class="cost">${escapeHtml(cost)}</div>` : ""}
          </div>
        </div>
      </ha-card>
    `;
  }

  _getRows() {
    if (this._rows.length === 0 && this._items.length > 0) this._applyShares();
    return this._rows;
  }

  _render() {
    if (!this.shadowRoot) return;

    if (!this._config || !this.hass) {
      this._clearDebugTimer();
      this.shadowRoot.innerHTML = `<style>${this._styles()}</style>`;
      return;
    }

    if (this._error) {
      this.shadowRoot.innerHTML = `
        <style>${this._styles()}</style>
        ${this._renderDebug()}
        <ha-card>
          <div class="error">
            <ha-icon icon="mdi:alert-circle"></ha-icon>
            <span>${escapeHtml(this._error)}</span>
          </div>
          ${this._renderWarnings()}
        </ha-card>
      `;
      this._scheduleDebugUpdate();
      return;
    }

    const locale = getNumberLocale(this.hass);
    const numberFormatOptions = getNumberFormatOptions(this.hass);
    const currency = getCurrency(this.hass, this._config.currency);
    const rows = this._getRows();

    const content =
      this._loading && rows.length === 0
        ? `<div class="loading">…</div>`
        : rows.length === 0
          ? `<div class="loading">No values</div>`
          : rows
              .map((item, index) =>
                this._renderEntityTile(
                  item,
                  index,
                  locale,
                  currency,
                  numberFormatOptions
                )
              )
              .join("");

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="list-container">
        ${this._renderDebug()}
        ${this._renderWarnings()}
        ${content}
      </div>
    `;
    this._scheduleDebugUpdate();
  }

  _styles() {
    return `
      :host {
        --etc-consumption-color: var(--energy-consumption-color, var(--primary-color, var(--primary-text-color, black)));
        --etc-ring-untracked-color: var(--secondary-text-color, rgba(127, 127, 127, 0.6));
      }

      .list-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .entity-card {
        display: block;
        overflow: hidden;
        position: relative;
      }

      .debug-card {
        display: block;
      }

      .debug-grid {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        gap: 6px 12px;
        padding: 12px 14px;
        color: var(--secondary-text-color);
        font-size: var(--ha-font-size-s);
        line-height: var(--ha-line-height-normal);
      }

      .debug-grid code,
      .debug-grid span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .debug-label {
        color: var(--primary-text-color);
        font-weight: var(--ha-font-weight-medium);
      }

      .entity-card.clickable {
        cursor: pointer;
      }

      /* The feedback of a Home Assistant tile, which is ha-ripple's layer over
         the card rather than an elevation: the tile colour at four percent
         while the pointer is on it and twelve while it is pressed, in fifteen
         milliseconds, so nothing about the row moves. The variables are the
         ones ha-ripple reads, so a theme that sets them sets this too. */
      .entity-card.clickable::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: var(
          --ha-ripple-hover-color,
          var(--ha-ripple-color, var(--etc-consumption-color))
        );
        opacity: 0;
        transition: opacity var(--ha-ripple-hover-duration, 15ms) linear;
      }

      .entity-card.clickable:hover::after {
        opacity: var(--ha-ripple-hover-opacity, 0.04);
      }

      .entity-card.clickable:active::after {
        background: var(
          --ha-ripple-pressed-color,
          var(--ha-ripple-color, var(--etc-consumption-color))
        );
        opacity: var(--ha-ripple-pressed-opacity, 0.12);
      }

      /* A tile keeps its icon and its words above ha-ripple by making them the
         later box, and here the wash is the last box of the row, so the content
         needs the higher layer: a layer over the words would dim them. */
      .container {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .entity-row {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
      }

      .ring-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .ring {
        display: block;
      }

      .ring-track {
        stroke: var(--divider-color, rgba(127, 127, 127, 0.2));
      }

      .ring-segment {
        stroke: var(--etc-consumption-color);
      }

      .ring-segment.ring-past {
        opacity: 0.25;
      }

      .ring-segment.ring-untracked {
        stroke: var(--etc-ring-untracked-color);
        opacity: 0.5;
      }

      .info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }

      .name {
        font-weight: var(--ha-font-weight-medium);
        font-size: var(--ha-font-size-m);
        line-height: 1.3;
        color: var(--primary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .entity-card.untracked .name {
        color: var(--secondary-text-color);
        font-weight: var(--ha-font-weight-regular);
      }

      .secondary {
        font-size: var(--ha-font-size-s);
        line-height: 1.3;
        color: var(--secondary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .values {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 1px;
        flex-shrink: 0;
      }

      .cost {
        font-size: var(--ha-font-size-s);
        color: var(--secondary-text-color);
        white-space: nowrap;
      }

      .consumption {
        font-weight: var(--ha-font-weight-medium);
        font-size: var(--ha-font-size-m);
        color: var(--primary-text-color);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }

      .loading {
        padding: 12px 14px;
        color: var(--secondary-text-color);
      }

      .error,
      .warning {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 14px;
        font-size: 13px;
      }

      .error {
        color: var(--error-color, #db4437);
      }

      .warning {
        color: var(--warning-color, #f4b400);
      }

      .warning-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    `;
  }

  getCardSize() {
    const rows = Math.max(this._items.length, this._rows.length);
    return Math.max(1, rows || this._resolvedEntities.length || 1);
  }

  static getConfigForm() {
    return {
      schema: [
        {
          name: "configuration",
          type: "expandable",
          flatten: true,
          schema: [
            {
              name: "collection_key",
              required: true,
              selector: { text: {} },
            },
            {
              name: "display_unit",
              selector: {
                select: {
                  mode: "dropdown",
                  options: ["Wh", "kWh", "MWh"],
                },
              },
            },
            {
              name: "price_entity",
              selector: {
                entity: {
                  filter: {
                    domain: "sensor",
                    unit_of_measurement: PRICE_PER_KWH_UNITS,
                  },
                },
              },
            },
            {
              name: "tap_action",
              selector: {
                ui_action: {
                  default_action: "more-info",
                  actions: ["more-info", "none"],
                },
              },
            },
            {
              name: "debug",
              selector: { boolean: {} },
            },
          ],
        },
        {
          name: "content",
          type: "expandable",
          flatten: true,
          schema: [
            {
              name: "name",
              selector: {
                select: {
                  multiple: true,
                  reorder: true,
                  options: [
                    { value: "area", label: "Area" },
                    { value: "entity", label: "Entity" },
                    { value: "floor", label: "Floor" },
                    { value: "device", label: "Device" },
                  ],
                },
              },
            },
            {
              name: "state_content",
              selector: {
                select: {
                  multiple: true,
                  reorder: true,
                  options: [
                    { value: "area_name", label: "Area name" },
                    { value: "floor_name", label: "Floor name" },
                    { value: "device_name", label: "Device name" },
                  ],
                },
              },
            },
          ],
        },
        {
          name: "filters",
          type: "expandable",
          flatten: true,
          schema: [
            {
              name: "exclude_entities",
              selector: {
                entity: {
                  multiple: true,
                  filter: { domain: "sensor", device_class: "energy" },
                },
              },
            },
            {
              name: "show_zero",
              selector: { boolean: {} },
            },
            {
              name: "show_untracked",
              selector: { boolean: {} },
            },
            {
              name: "untracked_name",
              selector: { text: {} },
            },
          ],
        },
      ],
      computeLabel: (schema) => {
        const labels = {
          configuration: "Configuration",
          content: "Content",
          filters: "Filters",
          collection_key: "Collection key",
          exclude_entities: "Hide entities",
          price_entity: "Current price",
          display_unit: "Display unit",
          show_zero: "Show zero values",
          show_untracked: "Show not captured consumption",
          untracked_name: "Name of the not captured row",
          name: "Name",
          state_content: "State content",
          tap_action: "Behavior on tap",
          debug: "Debug information",
        };
        return labels[schema.name];
      },
      computeHelper: (schema) =>
        ({
          collection_key:
            "Use the same energy_* key as the related Energy period card.",
          exclude_entities:
            "Selected energy sensors are excluded from the card.",
          price_entity:
            "Only sensors with a supported unit ending in /kWh are shown.",
          show_untracked:
            "Adds one row for the part of the house consumption no listed sensor covers.",
        })[schema.name],
      assertConfig,
    };
  }

  static getStubConfig() {
    return {
      type: "custom:ha_energy-tile-card",
      collection_key: "energy_1",
      display_unit: "kWh",
      show_zero: false,
      show_untracked: true,
      tap_action: {
        action: "more-info",
      },
    };
  }
}

if (!customElements.get("ha_energy-tile-card")) {
  customElements.define("ha_energy-tile-card", HaEnergyTileCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha_energy-tile-card",
  name: "Energy Tile Card",
  description:
    "Tile card with consumption, cost, and a consumption ring that shows each device's share of the whole house, including a row for what is not captured. Uses recorder-calculated period totals.",
  preview: true,
});

console.info(
  "%c HA_ENERGY-TILE-CARD %c v2.3.0-beta.8 ",
  "color: white; background: #03a9f4; font-weight: 600; padding: 2px 6px; border-radius: 3px 0 0 3px;",
  "color: #03a9f4; background: white; font-weight: 600; padding: 2px 6px; border-radius: 0 3px 3px 0; border: 1px solid #03a9f4;"
);
