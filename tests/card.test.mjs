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
  assert.ok(fields.includes("include_all_energy"));
  assert.ok(fields.includes("entities"));
  assert.ok(fields.includes("price_entity"));
  assert.ok(fields.includes("tap_action"));
  assert.ok(!fields.includes("currency"));
  assert.ok(!fields.includes("language"));
  assert.ok(!fields.includes("locale"));
  assert.doesNotThrow(() =>
    form.assertConfig({
      collection_key: "energy_1",
      include_all_energy: true,
    })
  );
});

test("uses native Home Assistant context pickers", () => {
  const fields = Object.fromEntries(
    Card.getConfigForm().schema.map((field) => [field.name, field])
  );

  assert.deepEqual(fields.name.selector, { entity_name: {} });
  assert.deepEqual(fields.name.context, {
    entity: "editor_context_entity",
  });
  assert.deepEqual(fields.state_content.selector, {
    ui_state_content: { allow_context: true },
  });
  assert.deepEqual(fields.state_content.context, {
    filter_entity: "editor_context_entity",
  });
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
