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
  assert.match(html, /recorder\/statistic_during_period/);
  assert.match(html, /Subscription/);
  assert.match(html, /Subscribed/);
  assert.match(html, /id="debug-last-event"/);
  assert.match(html, /Minute/);
});

test("requests one recorder-calculated total per entity", async () => {
  const calls = [];
  const card = createCard({
    callWS: async (message) => {
      calls.push(message);
      return { change: 42.5 };
    },
  });
  card._collectionStart = new Date("2025-01-01T00:00:00Z");
  card._collectionEnd = new Date("2026-01-01T00:00:00Z");
  card._lastFetchKey = card._buildFetchKey(["sensor.energy"]);

  await card._fetchData(["sensor.energy"], card._lastFetchKey);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    type: "recorder/statistic_during_period",
    statistic_id: "sensor.energy",
    fixed_period: {
      start_time: "2025-01-01T00:00:00.000Z",
      end_time: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.equal(card._items[0].consumptionKWh, 42.5);
});

test("does not refetch a historical period when the live state changes", async () => {
  let callCount = 0;
  let renderCount = 0;
  const card = createCard({
    callWS: async () => {
      callCount += 1;
      return { change: 42.5 };
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
      return { change: 5 };
    },
  });
  card._hass.states["sensor.energy"].state = "12";
  card._collectionStart = new Date(Date.now() - 86400000);
  card._collectionEnd = new Date(Date.now() + 60000);
  card._lastFetchKey = card._buildFetchKey(["sensor.energy"]);

  await card._fetchData(["sensor.energy"], card._lastFetchKey);

  assert.equal(card._items[0].consumptionKWh, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "recorder/statistic_during_period");
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
