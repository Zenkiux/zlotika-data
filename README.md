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

**Reference prices** (`out/prices.json`, `src/prices.ts`): usual prices per kg, litre or piece for the app's item vocabulary (`src/terms.json`).
- Lithuania: Barbora.lt search pages (robots.txt allows search).
- Poland: Rossmann.pl product search (regular, non-promo prices).
- Frisco.pl: built but **off** (`priceSources.frisco: false`), because its robots.txt offers the feed for personal, non-commercial use.

**Shops and hours** (`out/stores.json`, `src/stores.ts`): shops near the border from OpenStreetMap (ODbL), with hours replaced by the chains' own store locators where a shop matches (`src/locators/`: Lidl, Aldi, Rossmann, Pepco, Dino, Netto). Biedronka blocks automated access, so its shops keep OpenStreetMap hours or a chain-typical estimate.

**Leaflet reading** (Biedronka, Kaufland): each page is read once by Google's Gemini vision model (free tier; key in the optional `GEMINI_API_KEY` repository secret) and cached in `out/vision-cache.json`. Pages it doesn't reach fall back to PaddleOCR (`tools/paddle_page.py`, open source), then Tesseract. Toy and home catalogues are skipped.

**Shopper prices** (`src/crowd.ts`): prices photographed on shelf tags or receipts near Suwałki, Augustów, Sejny and Białystok, from [Open Prices](https://prices.openfoodfacts.org) (Open Food Facts, ODbL). Zlotika users can add to it from the app.

**Fuel** (`out/fuel.json`): EU Weekly Oil Bulletin (LT, PL), e-petrol.pl (PL, when reachable), and Poland's **legal maximum pump price**, published daily by the Minister of Energy in Monitor Polski (read through the Sejm ELI open-data API). Lithuanian per-station prices (LEA) are published on SharePoint, whose robots.txt disallows bots, so they are not collected until LEA offers a bot-friendly link.

Not collected yet:
- **Dino, Netto:** no shop in Suwałki.

## Your own copy: bring your own free key
The leaflet reader works best with a vision-model key. Each copy of this collector uses **its own** key; none is shared or included here.
1. Create a free key at https://aistudio.google.com/apikey (Google account, no card).
2. In your fork: Settings → Secrets and variables → Actions → New repository secret, name `GEMINI_API_KEY`. Or: `gh secret set GEMINI_API_KEY --repo <you>/<your-fork>`.
3. Without a key, everything still runs; leaflets are read with PaddleOCR and Tesseract instead (fewer, less accurate prices).

The key is only used server-side by GitHub Actions. The app never receives it.

## Run
```bash
npm run collect          # all sources
npm run one -- lidl      # one source
```
Node 24 or newer, with `sharp` and `tesseract.js` for leaflet OCR. `--max-http-header-size` is raised because Lidl sends very large response headers.

## Turning things off
Edit `config.json` and push. The app picks it up on its next refresh:
```json
{ "collectedEnabled": false, "leafletsEnabled": false, "disabledChains": ["lidl"],
  "priceSources": { "barbora": false, "rossmann": false, "frisco": false } }
```

## Schedule
`.github/workflows/collect.yml` runs daily at 04:17 UTC and publishes `out/` to GitHub Pages.
