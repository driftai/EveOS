(async function () {
  const fragmentBase = "fragments/";
  const names = await fetch(`${fragmentBase}manifest.json`, { cache: "no-store" }).then(r => r.json());
  const host = document.getElementById("dialog-host");
  for (const name of names) {
    const response = await fetch(`${fragmentBase}${name}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load interface fragment: ${name}`);
    host.insertAdjacentHTML("beforeend", await response.text());
  }

  const scripts = [
    "assets/js/api.js?v=3c076f85c4ba",
    "assets/js/state.js?v=36a9369af2f4",
    "assets/js/theme.js?v=0d11f1aadc7c",
    "assets/js/header-collapse.js?v=47ef8214399e",
    "assets/js/links.js?v=2ea71dfd35a6",
    "assets/js/canon.js?v=4fcde87b842e",
    "assets/js/smart-collections.js?v=ad16dfb97f5b",
    "assets/js/integrity/core.js?v=5cafa02057e9",
    "assets/js/integrity/rules.js?v=23cb9bb8b821",
    "assets/js/integrity/ui.js?v=aa28a17534d3",
    "assets/js/taxonomy/mentions.js?v=f424de40f7ae",
    "assets/js/taxonomy/core.js?v=c28fb13b35b0",
    "assets/js/taxonomy/inline.js?v=c9959370718e",
    "assets/js/taxonomy/picker.js?v=ec4e25a6b2b7",
    "assets/js/taxonomy/dashboard.js?v=d3cbd3159bf9",
    "assets/js/tree.js?v=c5e92e28868e",
    "assets/js/editor.js?v=6f6e175927b1",
    "assets/js/app-loader.js?v=63d0962679a6",
    "assets/js/narration/text.js?v=5ded239401a5",
    "assets/js/narration/integrity.js?v=6de25b744f4a",
    "assets/js/narration/store.js?v=94f85c510474",
    "assets/js/narration/browser.js?v=0789fbf0300e",
    "assets/js/narration/gemini.js?v=2cb52a7e00a1",
    "assets/js/narration/controller.js?v=b4cf2264a243",
    "assets/js/narration/cache-ui.js?v=7a1761c09e2b",
    "assets/js/narration/layout.js?v=24dd98d5a8e9",
    "assets/js/narration/ui.js?v=f44318a26f2c"
  ];

  for (const source of scripts) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${source}`));
      document.body.appendChild(script);
    });
  }
  await window.WorldBookAppReady;
  const controllers = [
    "assets/js/world-portal-view.js?v=3be0ff740abf",
    "assets/js/integration/core.js?v=5f1f85a4c26c",
    "assets/js/integration/operations.js?v=654635e153ab",
    "assets/js/integration/planner.js?v=e2798ff63842",
    "assets/js/integration/guide.js?v=e61b7ae3573b",
    "assets/js/integration/ui.js?v=f0dc092b3071",
    "assets/js/recovery.js?v=b7c01b39f15b"
  ];
  for (const source of controllers) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = source;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Could not load ${source}.`));
      document.body.appendChild(script);
    });
  }
})().catch(error => {
  console.error(error);
  document.body.innerHTML = `<main class="bootstrap-error"><h1>Eve OS World Book could not start</h1><p>${String(error.message || error)}</p></main>`;
});
