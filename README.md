# Zlotika collector

Data feed for the **[Zlotika app](https://github.com/Zenkiux/zlotika)**. The code is under the MIT licence. Collected prices and leaflet images belong to the retailers, and Zlotika is not affiliated with them.

Collects publicly visible promotions from Polish retailer websites once a day and writes `out/deals.json` (the app's Deals feed) plus `out/config.json` (the remote off switch).

## Rules this collector follows
- **Server side only:** runs once a day and never from users' phones.
- **robots.txt is obeyed** (`src/http.ts`), with at least 1.5 s between requests and an honest `ZlotikaBot` user agent.
- **No getting around blocks.** A 403, challenge page or CAPTCHA just fails that source. Kaufland, Carrefour, Action and Hebe block bots, so the app offers only their official leaflet links.
- **A failing source keeps yesterday's data**, so one broken site never empties the app.

## Sources (2026-11-10)
| Chain | Source | Items |
|---|---|---|
| Aldi | `aldi.pl/oferty` and next week (Next.js data) | ~60 |
| Rossmann | `rossmann.pl/products/v3/api/Products?Statuses=promotion` (first 8 pages) | ~770 |
| Lidl | `lidl.pl/h/...` category pages (`data-grid-data`), including Lidl Plus conditions | ~220 valid |

| Kaufland | Schwarz leaflet platform (kaufland.pl itself blocks bots and is never fetched) → **OCR** of page images | ~200 |
| Biedronka | biedronka.pl leaflet API → **OCR** of page images | varies |

**Leaflets:** `out/leaflets.json` lists the current Biedronka, Kaufland and Lidl leaflets, with page image URLs on the retailers' own servers, for the in-app reader. OCR deals carry `ocr: true` plus the leaflet and page, so the app shows the source page next to every automatically read price.

Not collected yet:
- **Dino, Netto:** no shop in Suwałki.

## Run
```bash
npm run collect          # all sources
npm run one -- lidl      # one source
```
Node 24 or newer, with no dependencies. `--max-http-header-size` is raised because Lidl sends very large response headers.

## Turning things off
Edit `config.json` and push. The app picks it up on its next refresh:
```json
{ "collectedEnabled": false, "leafletsEnabled": false, "disabledChains": ["lidl"] }
```

## Schedule
`.github/workflows/collect.yml` runs daily at 04:17 UTC and publishes `out/` to GitHub Pages.
