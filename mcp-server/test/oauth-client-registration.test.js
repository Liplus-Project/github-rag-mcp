import assert from "node:assert/strict";
import test from "node:test";

import { supportsRedirectUris } from "../server/oauth-client-registration.js";

const REQUIRED_URIS = [
  "http://127.0.0.1:43123/callback",
  "http://localhost:43123/callback",
];

test("reuses a registration that covers every requested redirect URI", () => {
  assert.equal(
    supportsRedirectUris(
      {
        client_id: "client-id",
        redirect_uris: [...REQUIRED_URIS].reverse(),
      },
      REQUIRED_URIS,
    ),
    true,
  );
});

test("reuses a registration whose redirect URI set is a superset", () => {
  assert.equal(
    supportsRedirectUris(
      {
        client_id: "client-id",
        redirect_uris: [
          ...REQUIRED_URIS,
          "http://127.0.0.1:49999/callback",
        ],
      },
      REQUIRED_URIS,
    ),
    true,
  );
});

test("rejects a stale registration from a different callback port", () => {
  assert.equal(
    supportsRedirectUris(
      {
        client_id: "client-id",
        redirect_uris: [
          "http://127.0.0.1:40000/callback",
          "http://localhost:40000/callback",
        ],
      },
      REQUIRED_URIS,
    ),
    false,
  );
});

test("rejects a registration missing one requested redirect URI", () => {
  assert.equal(
    supportsRedirectUris(
      {
        client_id: "client-id",
        redirect_uris: [REQUIRED_URIS[0]],
      },
      REQUIRED_URIS,
    ),
    false,
  );
});

test("rejects malformed cached registrations", () => {
  assert.equal(supportsRedirectUris(null, REQUIRED_URIS), false);
  assert.equal(supportsRedirectUris({}, REQUIRED_URIS), false);
  assert.equal(
    supportsRedirectUris({ client_id: "", redirect_uris: REQUIRED_URIS }, REQUIRED_URIS),
    false,
  );
  assert.equal(
    supportsRedirectUris({ client_id: "client-id", redirect_uris: "not-an-array" }, REQUIRED_URIS),
    false,
  );
});
