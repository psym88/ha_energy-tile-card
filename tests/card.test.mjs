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
          friendly_name: "Fallback name",
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

test("uses Home Assistant currency and user number format", () => {
  const card = createCard();
  card._render();

  assert.match(card.shadowRoot.innerHTML, /CHF/);
  assert.match(card.shadowRoot.innerHTML, /12,50/);
  assert.match(card.shadowRoot.innerHTML, /1\.235 kWh/);
});

test("provides a visual editor without locale configuration fields", () => {
  const form = Card.getConfigForm();
  const fields = form.schema.map((field) => field.name);

  assert.ok(fields.includes("collection_key"));
  assert.ok(fields.includes("exclude_entities"));
  assert.ok(!fields.includes("include_all_energy"));
  assert.ok(!fields.includes("entities"));
  assert.ok(fields.includes("price_entity"));
  assert.ok(fields.includes("tap_action"));
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
    Card.getConfigForm().schema.map((field) => [field.name, field])
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
  const priceField = Card.getConfigForm().schema.find(
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
