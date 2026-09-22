# Consumer API adapter design note (not implemented)

Who this is for: developers wondering why the server ignores the consumer app API even though the captured dump proves it works. The API the server does implement is in [upstream-api.md](upstream-api.md).

The captured dump proves the Polestar consumer app API yields three things the official M2M API does not:

1. **Car identity.** GraphQL `GetConsumerCarsV2` returns model name/year, registration number, structure week, and the `pno34` spec code that encodes trim, motor, and pack. The code is a single identifier that begins with the VIN; decoded, this car is a 2023 Polestar 2 long range dual motor with the XPLUSS package.
2. **Car renders.** GraphQL `GetCarImages` returns 6 angles of the exact specced car, opaque JPG plus transparent PNG, from car-images.polestar.com.
3. **App-side telematics.** `CarTelematicsV2` mirrors M2M battery, health, and odometer (kept as fallback only).

## Why it is not wired in

- **Unofficial and undocumented.** The GraphQL query documents are not published; the dump holds responses, not requests. Reconstructing queries without the schema would be guesswork that breaks silently.
- **Auth rotates hard.** Polestar ID access tokens live about 299 seconds and each refresh issues a new refresh token (rotation). A safe adapter must persist the rotated refresh token atomically on every refresh: lose it once and the car is locked out until re-login. The M2M credential has no such failure mode.

## Shape when it lands

- `ConsumerAuthProvider` implements the same `TokenProvider` interface (refresh-token grant against `polestarid.eu.polestar.com/as/token.oauth2`), persisting rotation to a file under `~/.config/polestar-mcp/`.
- A `ConsumerTransport` speaks GraphQL behind the same `Transport` seam.
- Tools: `get_car_details` (decode `pno34` to trim and pack), `get_car_images` (returns the 6 render URLs), gated behind `POLESTAR_CONSUMER_REFRESH_TOKEN`. Data feeds `get_car_status` extras (registration number, pack size) and the planner's `capacityKwh` default.
