const assert = require("node:assert/strict");
const { scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const test = require("node:test");
const { createPasswordHash, createResetSql } = require("../scripts/reset-owner-password.js");

const scrypt = promisify(scryptCallback);

test("Owner reset creates a compatible scrypt hash and limits the SQL update to Owner accounts", async () => {
  const password = "a-secure-test-password";
  const encoded = await createPasswordHash(password);
  const [, salt, digest] = encoded.split("$");
  const actual = await scrypt(password, salt, 64);
  const expected = Buffer.from(digest, "base64url");

  assert.equal(actual.length, expected.length);
  assert.equal(timingSafeEqual(actual, expected), true);

  const sql = createResetSql(encoded);
  assert.match(sql, /UPDATE users/);
  assert.match(sql, /WHERE role_id = 'owner'/);
  assert.match(sql, /DELETE FROM sessions/);
  assert.match(sql, /WHERE user_id IN \(SELECT id FROM users WHERE role_id = 'owner'\)/);
  assert.match(sql, /DELETE FROM login_attempts/);
  assert.match(sql, /COMMIT;$/);
  assert.throws(() => createResetSql("not-a-hash"), /Invalid password hash/);
});
