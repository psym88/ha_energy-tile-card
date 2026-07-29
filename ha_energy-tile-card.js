// HA Energy Tile Card
const ENERGY_UNITS = {
  Wh: 1,
  kWh: 1000,
  MWh: 1000000,
};

const COLLECTION_RETRY_INTERVAL_MS = 500;
const MAX_COLLECTION_RETRIES = 20;
const ZERO_CONSUMPTION_EPSILON_KWH = 0.01;
const PRICE_UNIT_PATTERN = /^.+\/kWh$/i;

function assertConfig(config) {
  if (
    !config ||
    typeof config.collection_key !== "string" ||
    !config.collection_key.startsWith("energy_")
  ) {
    throw new Error("collection_key is required and must start with energy_");
  }

  const autoEntities =
    config.entities === "energy" ||
    config.entities === "all_energy" ||
    config.include_all_energy === true;

  if (!autoEntities && !config.entity && !Array.isArray(config.entities)) {
    throw new Error(
      'Required field "entity", "entities", or automatic energy entities is missing'
    );
  }

  if (Array.isArray(config.entities) && config.entities.length === 0) {
    throw new Error('"entities" must not be empty');
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

function getSuggestedStatisticsPeriod(start, end) {
  const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
  if (days <= 8) return "hour";
  if (days > 370) return "month";
  return "day";
}

function findEnergyDataCollection(hass, collectionKey) {
  return hass?.connection?.[`_${collectionKey}`];
}

async function fetchStatistics(hass, statisticIds, start, end, period) {
  if (!statisticIds.length) return {};
  return hass.callWS({
    type: "recorder/statistics_during_period",
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    statistic_ids: statisticIds,
    period,
    types: ["change", "state"],
  });
}

function sumChange(rows) {
  let total = 0;
  for (const row of rows || []) {
    if (typeof row.change === "number") total += row.change;
  }
  return total;
}

function getStatisticState(row) {
  if (!row || typeof row !== "object") return null;
  return typeof row.state === "number" ? row.state : null;
}

function getLastStatisticState(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = getStatisticState(rows[index]);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

function getCurrentSensorValue(stateObj) {
  const value = parseFloat(stateObj?.state);
  return Number.isFinite(value) ? value : null;
}

function shouldIncludeLiveDelta(start, end) {
  const now = Date.now();
  return start.getTime() <= now && end.getTime() >= now;
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

  return {
    ...config,
    display_unit: displayUnit,
    show_zero: !configValueIsFalse(config.show_zero),
  };
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
    const formatted = hass.formatEntityName(stateObj, config);
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

class HaEnergyTileCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._hass = undefined;
    this._config = undefined;
    this._items = [];
    this._warnings = [];
    this._error = null;
    this._loading = true;

    this._collectionStart = undefined;
    this._collectionEnd = undefined;
    this._collectionUnsubscribe = undefined;
    this._collectionRetryTimer = undefined;
    this._collectionRetryCount = 0;
    this._subscribedCollectionKey = undefined;
    this._subscribedCollection = undefined;

    this._fetchInFlight = false;
    this._pendingFetch = false;
    this._lastFetchKey = "";
    this._requestId = 0;
    this._resolvedEntities = [];

    this._onClick = this._onClick.bind(this);
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;

    this._setupEnergyCollection();

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
    this._warnings = [];
    this._error = null;
    this._loading = true;
    this._lastFetchKey = "";

    this._setupEnergyCollection();
    this._render();
    this._maybeFetch();
  }

  connectedCallback() {
    this.shadowRoot?.addEventListener("click", this._onClick);
    this._setupEnergyCollection();
    this._render();
    this._maybeFetch();
  }

  disconnectedCallback() {
    this.shadowRoot?.removeEventListener("click", this._onClick);

    this._collectionUnsubscribe?.();
    this._collectionUnsubscribe = undefined;
    this._subscribedCollectionKey = undefined;
    this._subscribedCollection = undefined;

    if (this._collectionRetryTimer !== undefined) {
      window.clearTimeout(this._collectionRetryTimer);
      this._collectionRetryTimer = undefined;
    }
  }

  _onClick(event) {
    const card = event.target?.closest?.("ha-card[data-entity]");
    if (card) this._handleTap(card.dataset.entity);
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
      resolution: getSuggestedStatisticsPeriod(start, end),
    };
  }

  _getEntities() {
    if (!this._config || !this.hass) return [];

    if (
      this._config.entities === "energy" ||
      this._config.entities === "all_energy" ||
      this._config.include_all_energy === true
    ) {
      return getVisibleEnergySensors(this.hass);
    }

    const configured = Array.isArray(this._config.entities)
      ? this._config.entities
      : this._config.entity
        ? [this._config.entity]
        : [];

    const resolved = [];

    for (const entry of configured) {
      const entityId = typeof entry === "string" ? entry : entry?.entity;
      if (entityId && !isHiddenEntity(this.hass, entityId)) resolved.push(entityId);
    }

    return [...new Set(resolved)].sort((a, b) => a.localeCompare(b));
  }

  _buildFetchKey(entityIds) {
    return [
      entityIds.join(","),
      this._config.price_entity || "",
      this._collectionStart?.toISOString() || "",
      this._collectionEnd?.toISOString() || "",
      this._config.show_zero,
      this._config.display_unit,
      this.hass?.states?.[this._config.price_entity]?.state || "",
      ...entityIds.map((entityId) => this.hass?.states?.[entityId]?.state || ""),
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
    const requestId = ++this._requestId;
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

      const stats = await fetchStatistics(
        this.hass,
        validEntities,
        period.start,
        period.end,
        period.resolution
      );

      if (requestId !== this._requestId || fetchKey !== this._lastFetchKey) return;

      this._items = this._buildItems(validEntities, stats);
    } catch (error) {
      if (requestId !== this._requestId) return;

      this._error = error instanceof Error ? error.message : "Unknown error";
      this._items = [];
      console.error("[ha_energy-tile-card]", error);
    } finally {
      if (requestId === this._requestId) {
        this._fetchInFlight = false;
        this._loading = false;
        this._render();
      }

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
    const rows = stats[entityId] || [];

    let consumption = sumChange(rows);

    try {
      const { start, end } = this._getActivePeriodRange();

      if (shouldIncludeLiveDelta(start, end)) {
        const currentValue = getCurrentSensorValue(stateObj);
        const lastStatisticState = getLastStatisticState(rows);

        if (currentValue !== null && lastStatisticState !== null) {
          const liveDelta = currentValue - lastStatisticState;

          if (liveDelta > 0) {
            consumption += liveDelta;
          }
        }
      }
    } catch (_) {
      // Fall back to recorder statistics while the collection is not ready.
    }

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

    const totalKWh = items.reduce((sum, item) => sum + item.consumptionKWh, 0);

    for (const item of items) {
      item.percentage =
        totalKWh > 0
          ? Math.max(0, Math.min(100, (item.consumptionKWh / totalKWh) * 100))
          : null;
    }

    return items.sort((a, b) => b.consumptionKWh - a.consumptionKWh);
  }

  _getIcon(entityId) {
    const stateObj = this.hass.states?.[entityId];
    const entity = this.hass.entities?.[entityId];

    return (
      this._config.icon ||
      entity?.icon ||
      stateObj?.attributes?.icon ||
      entity?.original_icon ||
      "mdi:flash"
    );
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

  _renderEntityTile(item, locale, currency, numberFormatOptions) {
    const entityId = item.entity;
    const icon = this._getIcon(entityId);
    const name = buildName(this.hass, entityId, this._config.name);
    const secondary = buildStateContent(
      this.hass,
      entityId,
      this._config.state_content,
      locale,
      numberFormatOptions
    );
    const percentage = item.percentage ?? 0;

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
    const clickableClass = (this._config?.tap_action?.action ?? "more-info") === "none" ? "" : " clickable";

    return `
      <ha-card class="entity-card${clickableClass}" data-entity="${escapeHtml(entityId)}">
        <div class="container entity-row">
          <div class="header">
            <div class="icon-wrapper">
              <ha-icon icon="${escapeHtml(icon)}"></ha-icon>
            </div>

            <div class="info">
              <div class="name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
              ${secondary ? `<div class="secondary" title="${escapeHtml(secondary)}">${escapeHtml(secondary)}</div>` : ""}
            </div>

            <div class="cost">${escapeHtml(cost)}</div>
          </div>

          <div class="bar-row">
            <div class="bar-track">
              <div class="bar-fill" style="width: ${Math.max(0, Math.min(100, percentage))}%"></div>
            </div>
            <div class="consumption">${escapeHtml(consumption)}</div>
          </div>
        </div>
      </ha-card>
    `;
  }

  _render() {
    if (!this.shadowRoot) return;

    if (!this._config || !this.hass) {
      this.shadowRoot.innerHTML = `<style>${this._styles()}</style>`;
      return;
    }

    if (this._error) {
      this.shadowRoot.innerHTML = `
        <style>${this._styles()}</style>
        <ha-card>
          <div class="error">
            <ha-icon icon="mdi:alert-circle"></ha-icon>
            <span>${escapeHtml(this._error)}</span>
          </div>
          ${this._renderWarnings()}
        </ha-card>
      `;
      return;
    }

    const locale = getNumberLocale(this.hass);
    const numberFormatOptions = getNumberFormatOptions(this.hass);
    const currency = getCurrency(this.hass, this._config.currency);

    const content =
      this._loading && this._items.length === 0
        ? `<div class="loading">…</div>`
        : this._items.length === 0
          ? `<div class="loading">No values</div>`
          : this._items
              .map((item) =>
                this._renderEntityTile(
                  item,
                  locale,
                  currency,
                  numberFormatOptions
                )
              )
              .join("");

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="list-container">
        ${this._renderWarnings()}
        ${content}
      </div>
    `;
  }

  _styles() {
    return `
      :host {
        --etc-consumption-color: var(--energy-consumption-color, var(--primary-text-color, black));
      }

      .list-container {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .entity-card {
        display: block;
        overflow: hidden;
      }

      .entity-card.clickable {
        cursor: pointer;
      }

      .entity-card.clickable:active {
        opacity: 0.96;
      }

      .container {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .entity-row {
        padding: 12px 14px;
      }

      .header {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .icon-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }

      .icon-wrapper ha-icon {
        --mdc-icon-size: 24px;
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

      .secondary {
        font-size: var(--ha-font-size-s);
        line-height: 1.3;
        color: var(--secondary-text-color);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .cost {
        font-weight: var(--ha-font-weight-medium);
        font-size: var(--ha-font-size-m);
        color: var(--primary-text-color);
        white-space: nowrap;
        flex-shrink: 0;
      }

      .bar-row {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .bar-track {
        flex: 1;
        height: 8px;
        border-radius: 999px;
        background: var(--divider-color, rgba(127, 127, 127, 0.2));
        overflow: hidden;
      }

      .bar-fill {
        height: 100%;
        background: var(--etc-consumption-color);
        border-radius: 999px;
        transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
      }

      .consumption {
        font-size: var(--ha-font-size-s);
        color: var(--secondary-text-color);
        white-space: nowrap;
        flex-shrink: 0;
        min-width: 60px;
        text-align: right;
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
    return Math.max(1, this._items.length || this._resolvedEntities.length || 1);
  }

  static getConfigForm() {
    return {
      schema: [
        {
          name: "collection_key",
          required: true,
          selector: { text: {} },
        },
        {
          name: "include_all_energy",
          selector: { boolean: {} },
        },
        {
          name: "entities",
          visible: {
            field: "include_all_energy",
            operator: "not_eq",
            value: true,
          },
          selector: {
            entity: {
              multiple: true,
              filter: { domain: "sensor", device_class: "energy" },
            },
          },
        },
        {
          name: "price_entity",
          selector: {
            entity: {
              filter: { domain: "sensor", device_class: "monetary" },
            },
          },
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
          name: "show_zero",
          selector: { boolean: {} },
        },
        {
          name: "icon",
          selector: { icon: {} },
        },
        {
          name: "name",
          selector: {
            entity_name: {},
          },
        },
        {
          name: "state_content",
          selector: {
            ui_state_content: {
              allow_context: true,
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
      ],
      computeLabel: (schema, localize) => {
        const labels = {
          collection_key: "Energy collection key",
          include_all_energy: "Use all visible energy sensors",
          entities:
            localize("ui.panel.lovelace.editor.card.generic.entities") ||
            "Entities",
          price_entity: "Current energy price entity",
          display_unit: "Display unit",
          show_zero: "Show zero values",
          icon:
            localize("ui.panel.lovelace.editor.card.generic.icon") || "Icon",
          name:
            localize("ui.panel.lovelace.editor.card.generic.name") || "Name",
          state_content: "Secondary information",
          tap_action:
            localize("ui.panel.lovelace.editor.card.generic.tap_action") ||
            "Tap action",
        };
        return labels[schema.name];
      },
      computeHelper: (schema) =>
        schema.name === "collection_key"
          ? "Use the same energy_* key as the related Energy period card."
          : undefined,
      assertConfig,
    };
  }

  static getStubConfig() {
    return {
      type: "custom:ha_energy-tile-card",
      collection_key: "energy_1",
      include_all_energy: true,
      display_unit: "kWh",
      show_zero: false,
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
    "Tile card with consumption, cost, percentage bars, show_zero, and tap_action per entity. Uses recorder statistics with a live correction based on the latest statistics state.",
  preview: true,
});

console.info(
  "%c HA_ENERGY-TILE-CARD %c v1.1.2 ",
  "color: white; background: #03a9f4; font-weight: 600; padding: 2px 6px; border-radius: 3px 0 0 3px;",
  "color: #03a9f4; background: white; font-weight: 600; padding: 2px 6px; border-radius: 0 3px 3px 0; border: 1px solid #03a9f4;"
);
