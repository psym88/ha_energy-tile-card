# HA Energy Tile Card

Eine Home-Assistant-Dashboard-Karte für Energieverbrauch, Kosten und prozentuale Verbrauchsanteile.

## Funktionen

- Liest Recorder-Statistiken für den aktiven Zeitraum des Energy-Dashboards
- Unterstützt einzelne Sensoren, Sensorlisten oder alle sichtbaren Energiesensoren
- Zeigt Verbrauch, optional Kosten und einen prozentualen Balken
- Unterstützt `Wh`, `kWh` und `MWh`
- Öffnet per Klick den Mehr-Informationen-Dialog

## Voraussetzungen

- Home Assistant mit Energie-Dashboard und Recorder-Statistiken
- Energiesensoren mit `device_class: energy`
- Einheit `Wh`, `kWh` oder `MWh`
- `state_class: total` oder `total_increasing`

## Installation über HACS

1. Öffne in HACS das Drei-Punkte-Menü und **Benutzerdefinierte Repositories**.
2. Füge `https://github.com/psym88/ha_energy-tile-card` als Typ **Dashboard** hinzu.
3. Installiere **HA Energy Tile Card**.
4. Lade Home Assistant beziehungsweise den Browser-Cache neu.

HACS registriert normalerweise automatisch die Ressource:

```text
/hacsfiles/ha_energy-tile-card/ha_energy-tile-card.js
```

Falls nötig, füge sie unter **Einstellungen → Dashboards → Ressourcen** als JavaScript-Modul hinzu.

## Konfiguration

Alle sichtbaren Energiesensoren:

```yaml
type: custom:energy-tile-card
collection_key: energy_1
entities: energy
display_unit: kWh
show_zero: false
tap_action:
  action: more-info
```

Ausgewählte Sensoren mit aktuellem Preis pro kWh:

```yaml
type: custom:energy-tile-card
collection_key: energy_1
entities:
  - sensor.waschmaschine_energie
  - sensor.trockner_energie
price_entity: sensor.strompreis
currency: CHF
display_unit: kWh
name:
  - area
  - entity
state_content:
  - state
show_zero: false
```

Ein einzelner Sensor:

```yaml
type: custom:energy-tile-card
collection_key: energy_1
entity: sensor.gesamtenergie
```

| Option | Erforderlich | Standard | Beschreibung |
| --- | --- | --- | --- |
| `collection_key` | Ja | – | Schlüssel der Energy-Datensammlung, beispielsweise `energy_1` |
| `entity` / `entities` | Ja | – | Ein Sensor, eine Liste oder `entities: energy` |
| `price_entity` | Nein | – | Entität mit dem aktuellen Preis pro kWh |
| `currency` | Nein | `CHF` | Angezeigtes Währungskürzel |
| `display_unit` | Nein | `kWh` | `Wh`, `kWh` oder `MWh` |
| `show_zero` | Nein | `true` | Sensoren ohne Verbrauch anzeigen |
| `icon` | Nein | Sensor-Icon | Einheitliches Icon für alle Kacheln |
| `name` | Nein | `entity` | Bestandteile: `entity`, `device`, `area`, `floor` |
| `state_content` | Nein | `state` | Bestandteile: `state`, `device_name`, `area_name`, `floor_name` |
| `tap_action.action` | Nein | `more-info` | `more-info` oder `none` |

## Manuelle Installation

Kopiere `dist/ha_energy-tile-card.js` nach `/config/www/ha_energy-tile-card.js` und registriere `/local/ha_energy-tile-card.js` als JavaScript-Modul.

## Entwicklung

```bash
npm run build
npm run check
```

## Lizenz

[MIT](LICENSE)
