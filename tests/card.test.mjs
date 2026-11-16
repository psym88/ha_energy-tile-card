import assert from "node:assert/strict";
import test from "node:test";

class MockHTMLElement {
  attachShadow() {
    this.shadowRoot = {
      innerHTML: "",
      addEventListener() {},
      removeEventListener() {},
    };
    return this.shadowRoot;
  }
}

const registry = new Map();

globalThis.HTMLElement = MockHTMLElement;
globalThis.window = {
  customCards: [],
  setTimeout,
  clearTimeout,
};
globalThis.customElements = {
  define(name, constructor) {
    registry.set(name, constructor);
  },
  get(name) {
    return registry.get(name);
  },
};

await import("../ha_energy-tile-card.js");

const Card = registry.get("ha_energy-tile-card");

function createCard(overrides = {}) {
  const card = new Card();
  card._hass = {
    config: { currency: "CHF", language: "de-CH" },
    locale: { language: "de-CH", number_format: "decimal_comma" },
    states: {
      "sensor.energy": {
        entity_id: "sensor.energy",
        state: "1234.5",
        attributes: {
          device_class: "energy",
          friendly_name: "Fallback name",
          state_class: "total_increasing",
          unit_of_measurement: "kWh",
        },
      },
    },
    entities: {},
    devices: {},
    areas: {},
    floors: {},
    formatEntityName: () => "Home Assistant name",
    formatEntityState: () => "Home Assistant state",
    ...overrides,
  };
  card._config = {
    collection_key: "energy_1",
    display_unit: "kWh",
    show_zero: true,
    tap_action: { action: "none" },
  };
  card._items = [
    {
      entity: "sensor.energy",
      consumption: 1234.5,
      consumptionKWh: 1234.5,
      displayUnit: "kWh",
      cost: 12.5,
      percentage: 100,
    },
  ];
  card._loading = false;
  card._warnings = [];
  return card;
}

function flattenSchema(schema) {
  return schema.flatMap((field) => [
    field,
    ...(field.schema ? flattenSchema(field.schema) : []),
  ]);
}

test("uses Home Assistant currency and user number format", () => {
  const card = createCard();
  card._render();

  assert.match(card.shadowRoot.innerHTML, /CHF/);
  assert.match(card.shadowRoot.innerHTML, /12,50/);
  assert.match(card.shadowRoot.innerHTML, /1\.235 kWh/);
});

test("measures every ring against the house total and adds what is missing", () => {
  const card = createCard();
  card._config.show_untracked = true;
  card._items = [
    { entity: "sensor.first", consumptionKWh: 6, consumption: 6, displayUnit: "kWh", cost: null },
    { entity: "sensor.second", consumptionKWh: 2, consumption: 2, displayUnit: "kWh", cost: null },
  ];
  card._houseTotalKWh = 10;

  const rows = card._applyShares();

  assert.deepEqual(
    rows.map((row) => [row.arcStart, row.arcEnd]),
    [
      [0, 60],
      [60, 80],
      [80, 100],
    ]
  );
  assert.equal(rows[2].untracked, true);
  assert.equal(rows[2].consumptionKWh, 2);
});

test("keeps the circle inside the list when the collection has no house total", () => {
  const card = createCard();
  card._config.show_untracked = true;
  card._items = [
    { entity: "sensor.first", consumptionKWh: 6, consumption: 6, displayUnit: "kWh", cost: null },
    { entity: "sensor.second", consumptionKWh: 2, consumption: 2, displayUnit: "kWh", cost: null },
  ];
  card._houseTotalKWh = null;

  const rows = card._applyShares();

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.percentage),
    [75, 25]
  );
});

test("hides the missing part when it is switched off", () => {
  const card = createCard();
  card._config.show_untracked = false;
  card._items = [
    { entity: "sensor.first", consumptionKWh: 6, consumption: 6, displayUnit: "kWh", cost: null },
  ];
  card._houseTotalKWh = 10;

  assert.equal(card._applyShares().length, 1);
});

test("reads the house total of the period from the energy collection", () => {
  const card = createCard({ callWS: async () => ({}) });
  card._hass.connection = {
    _energy_1: {
      start: new Date("2025-01-01T00:00:00Z"),
      end: new Date("2025-01-02T00:00:00Z"),
      prefs: {
        energy_sources: [
          {
            type: "grid",
            stat_energy_from: "sensor.grid_import",
            stat_energy_to: "sensor.grid_export",
          },
          { type: "solar", stat_energy_from: "sensor.solar" },
        ],
      },
      stats: {
        "sensor.grid_import": [{ change: 10 }],
        "sensor.grid_export": [{ change: 2 }],
        "sensor.solar": [{ change: 5 }],
      },
      subscribe: () => () => {},
    },
  };
  card._hass.states["sensor.grid_import"] = {
    entity_id: "sensor.grid_import",
    state: "10",
    attributes: {
      device_class: "energy",
      state_class: "total_increasing",
      unit_of_measurement: "kWh",
    },
  };
  card._config = {
    collection_key: "energy_1",
    display_unit: "kWh",
    show_zero: false,
    show_untracked: true,
  };

  card._setupEnergyCollection();

  assert.equal(card._houseTotalKWh, 13);
});

test("prefers the configured home meter over the derived total", () => {
  const card = createCard({ callWS: async () => ({}) });
  card._items = [
    { entity: "sensor.first", consumptionKWh: 1, consumption: 1, displayUnit: "kWh", cost: null },
  ];
  card._config = {
    collection_key: "energy_1",
    display_unit: "kWh",
    show_zero: false,
    show_untracked: true,
  };
  card._hass.connection = {
    _energy_1: {
      start: new Date("2025-01-01T00:00:00Z"),
      end: new Date("2025-01-02T00:00:00Z"),
      prefs: {
        energy_sources: [
          { type: "home", stat_energy_to: "sensor.home_consumption" },
          {
            type: "grid",
            stat_energy_from: "sensor.grid_import",
            stat_energy_to: null,
          },
        ],
      },
      stats: {
        "sensor.home_consumption": [{ change: 20 }],
        "sensor.grid_import": [{ change: 10 }],
      },
      subscribe: () => () => {},
    },
  };

  card._setupEnergyCollection();

  assert.equal(card._houseTotalKWh, 20);
  assert.equal(card._applyShares()[1].untracked, true);
});

test("renders a ring per row instead of the icon and the bar", () => {
  const card = createCard();
  card._config.show_untracked = true;
  card._houseTotalKWh = 8;
  card._rows = [];
  card._items = [
    { entity: "sensor.energy", consumptionKWh: 6, consumption: 6, displayUnit: "kWh", cost: null },
  ];
  card._loading = false;

  card._render();

  const html = card.shadowRoot.innerHTML;
  assert.match(html, /<svg class="ring"/);
  assert.match(html, /class="ring-segment ring-current"/);
  assert.match(html, /class="ring-segment ring-untracked"/);
  assert.match(html, /Nicht erfasster Verbrauch/);
  assert.doesNotMatch(html, /ha-icon icon="mdi:flash"/);
  assert.doesNotMatch(html, /bar-track/);
});

test("names the missing part in the language of the user", () => {
  const english = createCard({
    locale: { language: "en" },
    config: { currency: "USD", language: "en" },
  });
  english._config.show_untracked = true;
  english._houseTotalKWh = 8;
  english._rows = [];
  english._items = [
    { entity: "sensor.energy", consumptionKWh: 6, consumption: 6, displayUnit: "kWh", cost: null },
  ];
  english._loading = false;
  english._render();

  assert.match(english.shadowRoot.innerHTML, /Not captured consumption/);

  const named = createCard();
  named._config.show_untracked = true;
  named._config.untracked_name = "Rest";
  named._houseTotalKWh = 8;
  named._rows = [];
  named._items = [
    { entity: "sensor.energy", consumptionKWh: 6, consumption: 6, displayUnit: "kWh", cost: null },
  ];
  named._loading = false;
  named._render();

  assert.match(named.shadowRoot.innerHTML, />Rest</);
});

test("washes a row on hover the way a Home Assistant tile does", () => {
  const card = createCard();
  card._config.tap_action = { action: "more-info" };
  card._render();

  const html = card.shadowRoot.innerHTML;
  assert.match(html, /class="entity-card clickable/);
  assert.match(
    html,
    /\.entity-card\.clickable:hover::after\s*\{\s*opacity: var\(--ha-ripple-hover-opacity, 0\.04\);/
  );
  assert.match(
    html,
    /\.entity-card\.clickable:active::after\s*\{\s*background: var\(\s*--ha-ripple-pressed-color,/
  );
  assert.match(html, /\.container\s*\{\s*position: relative;\s*z-index: 1;/);
  assert.doesNotMatch(html, /box-shadow/);

  card._config.tap_action = { action: "none" };
  card._render();

  assert.doesNotMatch(card.shadowRoot.innerHTML, /class="entity-card clickable/);
});

test("provides a visual editor without locale configuration fields", () => {
  const form = Card.getConfigForm();
  const fields = flattenSchema(form.schema).map((field) => field.name);

  assert.deepEqual(
    form.schema.map((field) => field.name),
    ["configuration", "content", "filters"]
  );
  assert.ok(form.schema.every((field) => field.type === "expandable"));
  assert.ok(form.schema.every((field) => field.flatten === true));
  assert.ok(fields.includes("collection_key"));
  assert.ok(fields.includes("exclude_entities"));
  assert.ok(!fields.includes("include_all_energy"));
  assert.ok(!fields.includes("entities"));
  assert.ok(fields.includes("price_entity"));
  assert.ok(fields.includes("tap_action"));
  assert.ok(fields.includes("debug"));
  assert.ok(!fields.includes("currency"));
  assert.ok(!fields.includes("language"));
  assert.ok(!fields.includes("locale"));
  assert.doesNotThrow(() =>
    form.assertConfig({
      collection_key: "energy_1",
    })
  );
});

test("discovers visible energy sensors and excludes selected entities", () => {
  const card = createCard();
  card._hass.states = {
    "sensor.first": {
      entity_id: "sensor.first",
      state: "1",
      attributes: {
        device_class: "energy",
        state_class: "total_increasing",
        unit_of_measurement: "kWh",
      },
    },
    "sensor.second": {
      entity_id: "sensor.second",
      state: "2",
      attributes: {
        device_class: "energy",
        state_class: "total_increasing",
        unit_of_measurement: "kWh",
      },
    },
    "sensor.power": {
      entity_id: "sensor.power",
      state: "3",
      attributes: {
        device_class: "power",
        unit_of_measurement: "W",
      },
    },
  };
  card._config.exclude_entities = ["sensor.second"];

  assert.deepEqual(card._getEntities(), ["sensor.first"]);
});

test("ignores obsolete entity inclusion settings", () => {
  const card = createCard();
  card._hass.states = {
    "sensor.first": {
      entity_id: "sensor.first",
      state: "1",
      attributes: {
        device_class: "energy",
        state_class: "total_increasing",
        unit_of_measurement: "kWh",
      },
    },
    "sensor.second": {
      entity_id: "sensor.second",
      state: "2",
      attributes: {
        device_class: "energy",
        state_class: "total_increasing",
        unit_of_measurement: "kWh",
      },
    },
  };
  card._config.entity = "sensor.first";
  card._config.entities = ["sensor.first"];

  assert.deepEqual(card._getEntities(), ["sensor.first", "sensor.second"]);
});

test("provides ordered name and secondary-information choices", () => {
  const fields = Object.fromEntries(
    flattenSchema(Card.getConfigForm().schema).map((field) => [
      field.name,
      field,
    ])
  );

  assert.deepEqual(
    fields.name.selector.select.options.map((option) => option.value),
    ["area", "entity", "floor", "device"]
  );
  assert.equal(fields.name.selector.select.multiple, true);
  assert.equal(fields.name.selector.select.reorder, true);
  assert.deepEqual(
    fields.state_content.selector.select.options.map((option) => option.value),
    ["area_name", "floor_name", "device_name"]
  );
  assert.equal(fields.state_content.selector.select.multiple, true);
  assert.equal(fields.state_content.selector.select.reorder, true);
});

test("filters the price picker by price-per-kWh units", () => {
  const priceField = flattenSchema(Card.getConfigForm().schema).find(
    (field) => field.name === "price_entity"
  );

  assert.equal(priceField.selector.entity.filter.domain, "sensor");
  assert.ok(
    priceField.selector.entity.filter.unit_of_measurement.includes("CHF/kWh")
  );
  assert.ok(
    !priceField.selector.entity.filter.unit_of_measurement.includes("CHF")
  );
});

test("uses Home Assistant entity name and state formatters", () => {
  const card = createCard();
  card._render();

  assert.match(card.shadowRoot.innerHTML, /Home Assistant name/);
  assert.match(card.shadowRoot.innerHTML, /Home Assistant state/);
});

test("retains a configured currency as a backward-compatible override", () => {
  const card = createCard();
  card._config.currency = "EUR";
  card._render();

  assert.match(card.shadowRoot.innerHTML, /€/);
  assert.doesNotMatch(card.shadowRoot.innerHTML, /CHF/);
});

test("honors Home Assistant's disabled digit grouping preference", () => {
  const card = createCard({
    locale: { language: "de-CH", number_format: "none" },
  });
  card._render();

  assert.match(card.shadowRoot.innerHTML, /1235 kWh/);
  assert.doesNotMatch(card.shadowRoot.innerHTML, /1[.'’\s]235 kWh/);
});

test("renders the optional recorder debug information first", () => {
  const card = createCard();
  card._config.debug = true;
  card._collectionStart = new Date("2025-01-01T00:00:00Z");
  card._collectionEnd = new Date("2026-01-01T00:00:00Z");
  card._statisticsUnsubscribe = () => {};
  card._lastStatisticsEvent = Date.now() - 65000;
  card._scheduleDebugUpdate = () => {};

  card._render();

  const html = card.shadowRoot.innerHTML;
  assert.ok(
    html.indexOf('<ha-card class="debug-card">') <
      html.indexOf('<ha-card class="entity-card')
  );
  assert.match(html, /recorder\/statistics_during_period/);
  assert.match(html, /Subscription/);
  assert.match(html, /Subscribed/);
  assert.match(html, /id="debug-last-event"/);
  assert.match(html, /Minute/);
});

test("requests the totals of every entity in one message", async () => {
  const calls = [];
  const card = createCard({
    callWS: async (message) => {
      calls.push(message);
      return { "sensor.energy": [{ change: 42.5 }] };
    },
  });
  card._collectionStart = new Date("2025-01-01T00:00:00Z");
  card._collectionEnd = new Date("2026-01-01T00:00:00Z");
  card._lastFetchKey = card._buildFetchKey(["sensor.energy"]);

  await card._fetchData(["sensor.energy"], card._lastFetchKey);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: "recorder/statistics_during_period",
    start_time: "2025-01-01T00:00:00.000Z",
    end_time: "2026-01-01T00:00:00.000Z",
    statistic_ids: ["sensor.energy"],
    period: "day",
    types: ["change"],
  });
  assert.equal(card._items[0].consumptionKWh, 42.5);
});

test("asks for hourly rows within two days and sums what the recorder reports", async () => {
  const calls = [];
  const card = createCard({
    callWS: async (message) => {
      calls.push(message);
      return {
        "sensor.energy": [{ change: 1.5 }, { change: 2.25 }],
        "sensor.other": [{ change: 4 }],
      };
    },
  });
  card._hass.states["sensor.other"] = {
    entity_id: "sensor.other",
    state: "4",
    attributes: {
      device_class: "energy",
      state_class: "total_increasing",
      unit_of_measurement: "kWh",
    },
  };
  card._collectionStart = new Date("2025-01-01T00:00:00Z");
  card._collectionEnd = new Date("2025-01-02T12:00:00Z");
  card._lastFetchKey = card._buildFetchKey(["sensor.energy", "sensor.other"]);

  await card._fetchData(["sensor.energy", "sensor.other"], card._lastFetchKey);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].period, "hour");
  assert.deepEqual(calls[0].statistic_ids, ["sensor.energy", "sensor.other"]);
  assert.deepEqual(
    card._items.map((item) => [item.entity, item.consumptionKWh]),
    [
      ["sensor.other", 4],
      ["sensor.energy", 3.75],
    ]
  );
});

test("does not refetch a historical period when the live state changes", async () => {
  let callCount = 0;
  let renderCount = 0;
  const card = createCard({
    callWS: async () => {
      callCount += 1;
      return { "sensor.energy": [{ change: 42.5 }] };
    },
  });
  card._render = () => {
    renderCount += 1;
  };
  card._collectionStart = new Date("2025-01-01T00:00:00Z");
  card._collectionEnd = new Date("2026-01-01T00:00:00Z");
  card._lastFetchKey = card._buildFetchKey(["sensor.energy"]);

  await card._fetchData(["sensor.energy"], card._lastFetchKey);
  const rendersAfterFetch = renderCount;
  card._hass.states["sensor.energy"].state = "9999";
  card._maybeFetch();

  assert.equal(callCount, 1);
  assert.equal(renderCount, rendersAfterFetch);
  assert.equal(card._items[0].consumptionKWh, 42.5);
});

test("uses only the recorder total for a period containing now", async () => {
  const calls = [];
  const card = createCard({
    callWS: async (message) => {
      calls.push(message);
      return { "sensor.energy": [{ change: 5 }] };
    },
  });
  card._hass.states["sensor.energy"].state = "12";
  card._collectionStart = new Date(Date.now() - 86400000);
  card._collectionEnd = new Date(Date.now() + 60000);
  card._lastFetchKey = card._buildFetchKey(["sensor.energy"]);

  await card._fetchData(["sensor.energy"], card._lastFetchKey);

  assert.equal(card._items[0].consumptionKWh, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "recorder/statistics_during_period");
});

test("refreshes active periods after Home Assistant generates statistics", async () => {
  let eventCallback;
  let eventType;
  let refreshCallback;
  let refreshDelay;
  let fetchCount = 0;
  let unsubscribeCount = 0;
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const card = createCard({
    connection: {
      subscribeEvents(callback, type) {
        eventCallback = callback;
        eventType = type;
        return Promise.resolve(() => {
          unsubscribeCount += 1;
        });
      },
    },
  });
  card._collectionStart = new Date(Date.now() - 86400000);
  card._collectionEnd = new Date(Date.now() + 60000);
  card._lastFetchKey = "cached";
  card._maybeFetch = () => {
    fetchCount += 1;
  };

  try {
    window.setTimeout = (callback, delay) => {
      refreshCallback = callback;
      refreshDelay = delay;
      return 1;
    };
    window.clearTimeout = () => {};

    card._setupStatisticsSubscription();
    await Promise.resolve();
    eventCallback();

    assert.equal(eventType, "recorder_5min_statistics_generated");
    assert.equal(refreshDelay, 10000);
    assert.equal(card._lastFetchKey, "cached");
    assert.equal(fetchCount, 0);

    refreshCallback();
    assert.equal(card._lastFetchKey, "");
    assert.equal(fetchCount, 1);

    card._collectionStart = new Date("2025-01-01T00:00:00Z");
    card._collectionEnd = new Date("2026-01-01T00:00:00Z");
    eventCallback();
    assert.equal(fetchCount, 1);
  } finally {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
    card.disconnectedCallback();
  }

  assert.equal(unsubscribeCount, 1);
});
