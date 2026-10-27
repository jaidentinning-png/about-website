const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin !== "https://discord.com") return originalFetch(input, options);
  if (url.pathname === "/api/v10/oauth2/token") {
    return Response.json({ access_token: "integration-test-token" });
  }
  if (url.pathname === "/api/v10/users/@me") {
    return Response.json({ id: "175928847299117063", username: "portalowner", discriminator: "0" });
  }
  if (url.pathname === "/api/v10/users/@me/guilds") return Response.json([]);
  return Response.json({ error: "Unexpected test Discord endpoint." }, { status: 404 });
};
