const { randomBytes, scrypt: scryptCallback } = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(scryptCallback);

function readHidden(prompt) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Run this script in an interactive terminal so the password is not echoed.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");

    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Password reset cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const characters = Array.from(value);
          if (characters.length) {
            characters.pop();
            value = characters.join("");
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f" && value.length < 200) {
          value += character;
          process.stdout.write("*");
        }
      }
    };

    input.on("data", onData);
  });
}

async function createPasswordHash(password) {
  const salt = randomBytes(16).toString("base64url");
  const digest = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${digest.toString("base64url")}`;
}

function createResetSql(passwordHash) {
  if (!/^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/.test(passwordHash)) {
    throw new Error("Invalid password hash.");
  }

  return `BEGIN;
UPDATE users
SET password_hash = '${passwordHash}', must_change_password = FALSE
WHERE role_id = 'owner';
DELETE FROM sessions
WHERE user_id IN (SELECT id FROM users WHERE role_id = 'owner');
DELETE FROM login_attempts;
COMMIT;`;
}

async function main() {
  const password = await readHidden("New Owner password (12-200 characters): ");
  if (password.length < 12 || password.length > 200) {
    throw new Error("Password must be between 12 and 200 characters.");
  }
  const confirmation = await readHidden("Confirm new Owner password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const passwordHash = await createPasswordHash(password);
  process.stdout.write(
    "\nCopy the SQL below into your Neon SQL Editor and run it. Then sign in with this new password.\n\n"
  );
  process.stdout.write(`${createResetSql(passwordHash)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createPasswordHash, createResetSql };
