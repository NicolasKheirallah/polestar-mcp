# Live contract findings

Who this is for: developers debugging a live error or weighing a change to the client. This records what the API does when probed, as a companion to the documented contract in [upstream-api.md](upstream-api.md).

Measured 2026-09-18T18:41Z against `https://pc-api.polestar.com/eu-north-1/data-portal/m2m` with the owner's own M2M credential and single authorized vehicle. VINs masked, coordinates rounded. These findings replace what the design had previously had to guess around: which identity header carries what, how the gateway treats VINs, which domains exist, and what the error and token endpoints look like live.

## Identity headers

| Request | Result |
| --- | --- |
| `x-client-id` = Data Portal Account ID | `200` |
| `x-client-id` = OAuth clientId (the old `config.ts` fallback) | `403 AUTHZ_CLIENT_ID_MISMATCH`: "The x-client-id header does not match the identity associated with this token." |
| `x-client-id` omitted | `400 VALIDATION_INVALID_PARAMETER` |
| `x-delegated-account-id` = a value that does not exist | `200`, silently ignored |

Consequences: the Account ID is a separate identifier and is required; the client-ID fallback was broken by construction. The Account ID observed here equals the Polestar ID subject identifier (`sub`) from the consumer ID token, i.e. a UUID, not an email. An invalid delegated account is accepted without error, so delegation cannot be validated by probing: the server never assumes a delegated ID took effect.

## VIN handling

| Request | Result |
| --- | --- |
| Syntactically valid VIN the credential cannot see | `403 AUTHZ_VIN_UNAUTHORIZED` with `details.requested_vin` |
| Malformed VIN (short, 5 chars) | `403 AUTHZ_VIN_UNAUTHORIZED`: the gateway does not validate format |

So VIN format checking exists only where we put it (the tool input schema), and any unauthorized or typo'd VIN reads as an authorization failure. The hint for `AUTHZ_VIN_UNAUTHORIZED` mentions both cases.

## Domain list

| Request | Result |
| --- | --- |
| `/v1/vehicles/{vin}/telemetry/not-a-real-domain` | `404 VALIDATION_RESOURCE_NOT_FOUND`: "Unsupported telematics domain: ..." |

`VALIDATION_RESOURCE_NOT_FOUND` is not `DATA_NOT_AVAILABLE`. A mistyped domain is a contract error, not an empty report; treating the two alike would hide a bug in our own routing.

## Live domain scan, single authorized vehicle

All 15 domains answered `200` except `is-at-charge-location` (`404 DATA_NOT_AVAILABLE`). Key counts and the metadata-only domains confirm the captured dump was not stale:

- `charge-locations`: 5 keys, `vin`, `id`, `utc0`, `metaReceivedAt`, `metaEventId`. No locations at all, live.
- `charge-now`: 5 keys, the only content is `syncedOverrideChargeTimer.updatedAt`. No boolean state, live.
- `battery`: 14 keys; no volts/amps/watts, no since-charge or trip consumption, no breakdown, live.
- `availability`: `AVAILABILITY_STATUS_AVAILABLE` + `USAGE_MODE_ABANDONED`, reported 15 minutes before the probe.
- `location`: `coordinate.latitude`/`longitude` numbers, altitude and speed strings, heading number.

`utc0: true` appears on `charge-locations` and `parking-climate-timer` only; `global-charge-timer` carries an explicit `timeZone.offsetMinutes` per boundary instead. The gateway gives no field that disambiguates `utc0`, so the server renders the raw hour and the offset and never invents a single interpretation.

## Error envelope shape

`{ error: { code, message, httpStatus, requestId, timestamp, details? } }`, confirmed. Two gotchas: `message` is itself an escaped JSON string for `VALIDATION_INVALID_PARAMETER`, and timestamps in error envelopes are ISO-8601 while payload timestamps are protobuf `{seconds, nanos}` objects.

## Token endpoint

`POST /token` with `{clientId, clientSecret}` and no scope still returns a token that reads all 15 domains; `tokenType` is `Bearer` and `expiresIn` is 3600. Requesting the explicit scope union is therefore a forward-compatibility choice, not a requirement, and a smaller scope set is available to callers who want least-privilege tokens.

## No published contract at the gateway

`openapi.json`, `swagger.json`, `api-docs`, `/v1` and `/` all answer the Apigee "Missing Authentication Token" `403` (i.e. no such route), and data-portal.polestar.com redirects to login. There is no machine-readable spec reachable programmatically, so field-level truth for this project is the captured dump plus live probes, pinned by the fixture schema tests.
