window.WorldBookAppReady = (async function () {
  const base = "assets/js/app/chains/";
  const manifest = await fetch(`${base}manifest.json`, { cache: "no-cache" }).then(response => {
    if (!response.ok) throw new Error("Could not load the app chain manifest.");
    return response.json();
  });
  const sources = await Promise.all(manifest.map(async name => {
    const response = await fetch(`${base}${name}`, { cache: "no-cache" });
    if (!response.ok) throw new Error(`Could not load app layer: ${name}`);
    return `\n/* app-chain:${name} */\n${await response.text()}`;
  }));
  Function(sources.join("\n"))();
})();
