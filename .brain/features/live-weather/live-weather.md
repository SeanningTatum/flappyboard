# Feature: Live Weather

_Last updated: 2026-07-28_

**Status: planned.** Design reviewed round 1 —
`plans/2026-07-28-live-weather.html`. Five decisions answered; **two still open**
(decision 6, where the cache lives; decision 7, geolocation precision). Deferred
by decision 5 until `[[tv-pairing]]`, `[[family-grants]]` and `[[kiosk-display]]`
are verified and shipped.

## Purpose
Stop the board asserting weather figures it cannot stand behind. Today
`board.generate` answers "what's the weather in Oslo" with `web_search`, and a
search index returns whatever the crawler last saw — so temperature was measured
**6–10 °C wrong in every configuration tried**, against Open-Meteo as ground
truth. This replaces the search path for weather with a real weather API.

`web_search` stays for scores and news, where it is accurate.

## Why search cannot be fixed by configuration

Checked against the API reference rather than assumed:

- `web_search`'s only parameters are `max_uses`,
  `allowed_domains`/`blocked_domains`, `user_location`. **There is no freshness or
  cache parameter.**
- `web_fetch` **only fetches URLs already present in the conversation** — it is not
  a crawler, which is why adding it alongside search changed nothing.
- Prompt caching (`cache_control`) caches our own prompt prefix and has no bearing
  on search results.

The accuracy pattern is structural: sunset is right because it is computed from
date and latitude and is static all day; scores and news are right because they
stop changing once published; temperature is wrong because it is the one value
that changes hourly, so a crawled snippet is old by construction.

## How It Works (as designed)

The existing router already picks a *request shape* from one boolean, so this adds
a third shape rather than a new mechanism:

1. Haiku router returns intent + place (was: one boolean).
2. Weather intent with a place → **WEATHER route**.
3. Geocode the place via Open-Meteo (decision 2), then fetch the forecast.
4. Call Sonnet with **tools omitted entirely** — the way `PLAIN_ROUTE` already
   omits them — and a prompt carrying the real fields, forbidding any figure not
   present in them.

That last point is what kills the second bug run C recorded: a
`FEELS LIKE EVENING 5 °C` segment that "does not correspond to anything". The model
invented it because it had a 6×24 grid to fill and no real fields to fill it with.
Hand it typed values and you can constrain it.

## Round 1 additions

**A day-long cache** (phase 4b). One fetch per city per day instead of one per
board.

> ⚠️ **The trap, recorded because the requirement as first stated would have
> reintroduced the bug:** caching *the current reading* for 24 hours means a board
> can show a day-old temperature — worse than the few-hours-stale snippets being
> removed. What works instead: cache the day's **hourly series** and read the bucket
> matching the current hour. Cost is hourly rather than 15-minute resolution, about
> 1 °C of mid-hour drift against the 6–10 °C being fixed. Geocoding caches
> separately and indefinitely, since a city's coordinates do not change.

**Location from the phone** (phase 4c), so "what's the weather" needs no place
name. Needs a secure context and a permission prompt — the same constraint the
voice button already lives under. On refusal it falls back to the place-name path;
**no default location is invented**, because a board confidently showing the wrong
city is worse than one asking which city.

## Open decisions

| # | Question | Note |
|---|----------|------|
| 6 | Where does the cache live? | **This project has no KV binding today** — `rules/cloudflare.md` lists `DATABASE`, `AI`, `BOARD`, `EXAMPLE_WORKFLOW`, `ASSETS`. KV means a new binding in *both* the default and `preview` envs. Alternative with precedent: a per-city DO via `idFromName("weather:" + lat + "," + lon)`, the same trick `[[tv-pairing]]` uses for device codes. |
| 7 | Geolocation precision and refusal behaviour | Recommended: round to ~10 km (weather is identical across it, the household's exact address never leaves the phone, and the cache key hits far more often). Third option — ask once and store on the board — arguably fits a wall-mounted display better, since a board's location is fixed and a phone's is not. |

## Key Files (planned)

| File | Role |
|------|------|
| `app/lib/board/weather.ts` | Pure core — schemas, WMO code map, unit derivation, board renderer |
| `app/lib/board/weather-cache.ts` | Pure cache-key and hour-bucket maths, injected clock |
| `app/services/weather.ts` | Effect Tag + Layer over Open-Meteo |
| `app/services/board-agent.ts` | Router schema, third `Route`, weather prompt, pre-fetch |
| `app/models/errors/board.ts` | `WeatherUnavailableError` |
| `app/lib/effect-trpc.ts` | **Two** edits — the `APP_ERROR_TAGS` entry *and* the `case` |

## Dependencies
- `[[llm-board-agent]]` — extends its router and `Route` shape
- Deferred behind `[[tv-pairing]]` / `[[family-grants]]` / `[[kiosk-display]]` per decision 5
- External: Open-Meteo (unauthenticated; see the open question on whether that is acceptable in the request path)

## Tagged Errors

| Error | Where raised | tRPC code |
|-------|--------------|-----------|
| `WeatherUnavailableError` | geocoding empty, fetch failed, decode failed | SERVICE_UNAVAILABLE (TBD) |

## The bar this has to clear

Temperature within rounding of an independent Open-Meteo call made at the same
moment — the same method the run-C and run-E verification docs used to catch the
staleness. Not "looks right": the delta gets stated as a number.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed live-weather plan (round 1) |
