# The upstream API contract

Who this is for: developers who want to understand what the server is talking to, debug a live error, or build their own client. This page records the parts of the Polestar Data Portal M2M API that this implementation actually depends on. what each endpoint returns in practice is in [tools-reference.md](tools-reference.md).

## What the M2M API is

The Data Portal M2M API is Polestar's machine-to-machine developer API (part of the EU Data Act developer portal). It is different from the API the Polestar phone app uses: the app talks to a consumer backend (GraphQL operations such as `GetConsumerCarsV2` and `CarTelematicsV2`, authenticated through `polestarid.eu.polestar.com`), while the M2M API is a credential-based REST API intended for the vehicle owner to share their car's data with services. The captured dump in the parent directory contains both kinds of traffic; this server implements only the M2M side.

## Base URL and shape

- Base URL: `https://pc-api.polestar.com/eu-north-1/data-portal/m2m`
- Every documented operation is a GET. The v1 API is read-only.
- Vehicle routes are addressed by VIN, 17 characters, case-insensitive in the path.
- Rate limits: 10,000 calls per client per day and 100 requests per minute (the portal's "Begränsningar" section). A client that polls in a loop exhausts the day; a fan-out or an eager agent exhausts the minute first. Both are enforced server-side.
- No historical data: the API returns the latest known value only. Trends exist only if this server records them itself (`POLESTAR_HISTORY_DIR`).
- No guarantee of currency: values are "last known", and the portal says so. On the reference vehicle the charging settings were three weeks stale at capture (`updatedAt` against `metaReceivedAt` in `dataportal/charging/global-charge-timer.json`, 24.7 days, and 22.9 in `amp-limit.json`) while telemetry arrived 6 seconds before capture, so every payload is rendered with its age.
- Region: available only for vehicles in the EU/EEA.
- Data availability varies by platform, connectivity, backend support and region (stated by the portal), which is why absence of a field is treated as "unreported", never as zero.

## Authentication

The token endpoint is `POST {base}/token` with a JSON body:

```json
{
  "clientId": "<client id>",
  "clientSecret": "<client secret>",
  "scope": "pdp-telemetry/battery pdp-charging/targetSoc ..."
}
```

The scope is optional on the wire. This server always sends the deduplicated union of its 15 domain scopes (see the scope column in the [tool table](tools-reference.md#the-domain-tools-15--list_vehicles--list_domains)), so one token covers every tool call. The response carries at least `accessToken` and `expiresIn` (seconds); the client caches it until `expiresIn` minus a five minute skew.

Token-endpoint errors come back in one of two shapes, and the client reads both:

- Polestar-style: `{ "error": { "code": "...", "message": "...", "requestId": "...", "timestamp": "..." } }`
- OAuth-style: `{ "error": "invalid_client", "error_description": "..." }`

## Request headers

| Header | Sent when | Meaning |
| --- | --- | --- |
| `authorization` | always | `Bearer <accessToken>` |
| `x-client-id` | always | The **Account ID** from the Data Portal page. This is the caller identity, and it is not the OAuth client ID |
| `x-delegated-account-id` | third-party credentials only | Selects the account whose shared VINs you access when you were given credentials by someone else |
| `accept` | always | `application/json` |

The Account ID / client ID distinction is the most common setup confusion. The OAuth client ID and client secret authenticate the credential at the token endpoint; the Account ID identifies whose data you are asking for on every vehicle route afterwards. The Data Portal UI shows both.

## Response envelope

Every domain response is wrapped:

```json
{
  "data": { "..." : "the domain payload" },
  "meta": { "domain": "battery", "vin": "YSMTEST22PL000001" }
}
```

`meta` names the domain and the VIN it was served for. The client unwraps the envelope, so MCP tools return only the payload.

## The availability model

Fields are reported independently: a car that has no washer-fluid sensor simply omits the field, and a car that reports nothing at all for a domain answers with an error instead. The documented rule:

- A domain with no data returns HTTP 404 with error code `DATA_NOT_AVAILABLE`. This is a normal answer for domains a vehicle does not support, most often `is-at-charge-location`.
- The client models that single case as `null` (tools render it as a plain sentence), and treats every other 4xx/5xx as a real error.

## Error shape

All API errors share one envelope:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid VIN format.",
    "httpStatus": 400,
    "requestId": "req-42",
    "timestamp": "2026-01-01T00:00:00Z",
    "details": { "requested_vin": "YSMTEST22PL000001" }
  }
}
```

`requestId` and `timestamp` are the useful ones when reporting a problem: they are what Polestar support can look up. The server preserves them on `PolestarApiError` and on `AuthError`.

## Endpoints used

| Route | Purpose |
| --- | --- |
| `POST /token` | Client-credentials token for all scopes |
| `GET /v1/vehicles` | VINs the credential may access |
| `GET /v1/vehicles/{vin}/telemetry/{availability,battery,exterior,health,location,odometer,parking-climatization,pre-cleaning}` | The eight telemetry domains |
| `GET /v1/vehicles/{vin}/charging/{amp-limit,charge-locations,charge-now,global-charge-timer,parking-climate-timer,target-soc,is-at-charge-location}` | The seven charging domains |

## Write scopes without write endpoints

Tokens can carry write-flavored scopes such as `pdp-charging/targetSoc` and `pdp-charging/overrideChargeTimer`, and the read endpoints documented here use those same scope names. What the sandbox documentation does not publish is any v1 write endpoint: there is no documented way to set a target state of charge or override a charge timer over the M2M API today. The server therefore requests the union of its domain scopes (overridable with `POLESTAR_SCOPES` for a least-privilege token) and implements only reads. Nothing here writes; the flag that would gate future write tools registers nothing until endpoints exist.

## What the server adds on top of the contract

The API is a bare request/response surface; the server adds the operational discipline a 10,000-calls-per-day credential needs. These behaviors are the server's own, not the API's:

- **Identity assertions.** The envelope labels each response with its VIN and domain, and payloads repeat the VIN. The client refuses a response labelled for a different vehicle or domain (`VIN_MISMATCH`, `DOMAIN_MISMATCH`) rather than presenting one car's telemetry as another's.
- **Retry with limits.** 429 responses (honoring `Retry-After` when present) and 502/503 gateway errors are retried up to three times with capped exponential backoff; every attempt, including retries, is metered against the daily budget before it goes out.
- **Caching.** Repeated reads are served locally with a per-domain freshness policy and stale-while-revalidate, so latency never waits on Polestar and the budget is spent only on genuinely new information.
- **Per-minute ceiling.** A rolling 100/minute window (`POLESTAR_BUDGET_PER_MINUTE`). Because a minute window always frees on its own, the transport waits out the remaining time when that wait still fits the request deadline, and only surfaces `RATE_LIMIT_MINUTE` when it would park the caller too long.
- **Fail-closed budget.** When the daily allowance is spent, the server refuses to send further calls (with the reset time in the error) instead of hammering an API that will only answer 429.

## Where the portal page disagrees with the API

Measured with the owner's own credential; the "API
Documentation" page is Swedish-localised prose, not the OpenAPI file.

| Portal page says | Measured behaviour |
| --- | --- |
| Required headers are `accept`, `authorization`, `x-api-key` | M2M calls succeed with `accept` + `authorization` + **`x-client-id`** and **no `x-api-key`**. The page never mentions `x-client-id`, yet omitting it is `400 VALIDATION_INVALID_PARAMETER` and sending the OAuth client id there is `403 AUTHZ_CLIENT_ID_MISMATCH` |
| Status codes 200/202/204/400/401/404/406/409/422/500/502 | **403 and 429 are both observed live** but absent from the table; 406/409/422 have never been observed |
| Battery includes charging current and voltage; odometer includes trip-since-charge; health includes tyre pressure values; parking climatization includes cabin temperature; exterior includes a sunroof; availability includes a reason for unavailability | None of these appeared in the reference vehicle's payloads. They are contract fields a given car may not report. They are documented as optional, not absent |
| `charge-locations` lists configured charging locations | Over M2M it answers with a settings record (`id`, `utc0`) and no addresses |
