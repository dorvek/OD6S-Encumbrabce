/**
 * OD6S Encumbrance Tracker v1.2
 *
 * Each item in the inventory counts as 1 slot (no weight fields needed).
 * Carry limit defaults to STR dice × multiplier, overridable per character.
 */

const MODULE_ID = "od6s-encumbrance";

// ─────────────────────────────────────────────────────────────────
// Die code parser  "3D+2" → 3.67,  "2D" → 2,  "4D+1" → 4.33
// ─────────────────────────────────────────────────────────────────
function parseDiceCode(raw) {
  if (!raw) return 0;
  const str = String(raw).trim().toUpperCase();
  const match = str.match(/^(\d+)D([+-]\d+)?$/);
  if (!match) {
    const num = parseFloat(str);
    return isNaN(num) ? 0 : num;
  }
  const dice = parseInt(match[1], 10);
  const pips = match[2] ? parseInt(match[2], 10) : 0;
  return dice + pips / 3;
}

// ─────────────────────────────────────────────────────────────────
// Find Strength in OD6S actor data
// ─────────────────────────────────────────────────────────────────
function getStrengthDice(actor) {
  const attrs = actor.system?.attributes ?? {};

  for (const key of ["str", "strength", "physique", "phy"]) {
    if (attrs[key] !== undefined) {
      // OD6S stores the die code in .base (e.g. "3D+1")
      const val = attrs[key]?.base ?? attrs[key]?.value ?? attrs[key]?.total ?? attrs[key];
      const parsed = parseDiceCode(val);
      if (parsed > 0) return parsed;
    }
  }

  for (const [, attr] of Object.entries(attrs)) {
    const label = (attr?.label ?? attr?.name ?? "").toLowerCase();
    if (label.includes("str") || label.includes("strength") || label.includes("phy")) {
      const val = attr?.base ?? attr?.value ?? attr?.total ?? attr;
      const parsed = parseDiceCode(val);
      if (parsed > 0) return parsed;
    }
  }

  return 0;
}

// ─────────────────────────────────────────────────────────────────
// Item types that should NOT count as carried slots
// (passive abilities, force powers, species traits, etc.)
// ─────────────────────────────────────────────────────────────────
const IGNORED_TYPES = new Set([
  "ability", "advantage", "disadvantage", "special",
  "specialability", "power", "forcepower", "force",
  "skill", "trait", "feature", "species", "career"
]);

// ─────────────────────────────────────────────────────────────────
// Core encumbrance calculation — counts items as slots, not weight
// ─────────────────────────────────────────────────────────────────
function calcEncumbrance(actor) {
  if (!actor) return null;

  let totalSlots = 0;
  for (const item of actor.items) {
    if (IGNORED_TYPES.has(item.type?.toLowerCase())) continue;
    totalSlots += 1; // each physical item = 1 slot
  }

  // ── Carry limit ───────────────────────────────────────────────
  const override = actor.getFlag(MODULE_ID, "carryLimitOverride");
  let carryLimit;

  if (override !== undefined && override !== null && override !== "") {
    carryLimit = parseInt(override, 10);
  } else {
    const strDice = getStrengthDice(actor);
    const multiplier = game.settings.get(MODULE_ID, "strMultiplier");
    carryLimit = strDice > 0
      ? Math.round(strDice * multiplier)
      : game.settings.get(MODULE_ID, "defaultCarryLimit");
  }

  return {
    current: totalSlots,
    max: carryLimit,
    over: totalSlots > carryLimit,
    pct: Math.min((totalSlots / carryLimit) * 100, 100)
  };
}

// ─────────────────────────────────────────────────────────────────
// Inject the encumbrance bar into the actor sheet
// ─────────────────────────────────────────────────────────────────
function injectEncumbranceBar(app, html) {
  const actor = app.actor ?? app.document;
  if (!actor || actor.type === "npc" || actor.type === "vehicle") return;

  const enc = calcEncumbrance(actor);
  if (!enc) return;

  const overClass   = enc.over ? "enc-over" : "";
  const overText    = enc.over ? " ⚠ Over limit!" : "";
  const hasOverride = actor.getFlag(MODULE_ID, "carryLimitOverride") != null;
  const sourceLabel = hasOverride ? " (manual)" : " (from STR)";

  const barHtml = `
    <div class="enc-tracker ${overClass}" id="enc-tracker-${actor.id}">
      <div class="enc-label">
        <span class="enc-text">
          Slots: <strong>${enc.current}</strong> / ${enc.max}${sourceLabel}${overText}
        </span>
        <a class="enc-edit" title="Set a manual carry limit (overrides STR)">✎</a>
        ${hasOverride ? `<a class="enc-clear" title="Clear override — use STR again">✕</a>` : ""}
      </div>
      <div class="enc-bar-bg">
        <div class="enc-bar-fill ${overClass}" style="width:${enc.pct.toFixed(1)}%"></div>
      </div>
    </div>
  `;

  const targets = [
    ".sheet-body",
    ".tab.active",
    ".tab[data-tab='main']",
    ".tab[data-tab='inventory']",
    "form.sheet",
    "form"
  ];
  let inserted = false;
  for (const sel of targets) {
    const el = html.find(sel).first();
    if (el.length) { el.prepend(barHtml); inserted = true; break; }
  }
  if (!inserted) html.append(barHtml);

  // ── Edit override ─────────────────────────────────────────────
  html.find(".enc-edit").on("click", async () => {
    const current = actor.getFlag(MODULE_ID, "carryLimitOverride") ?? enc.max;
    const result = await Dialog.prompt({
      title: "Set Carry Limit Override",
      content: `
        <p>Enter a fixed number of item slots for <strong>${actor.name}</strong>.</p>
        <p style="font-size:0.85em;color:#888">Click ✕ on the sheet to go back to automatic (STR-based).</p>
        <input type="number" id="enc-limit-input" value="${current}"
               min="1" step="1" style="width:100%;margin-top:4px">
      `,
      callback: (html) => html.find("#enc-limit-input").val(),
      rejectClose: false
    });
    if (result !== null && result !== undefined && result !== "") {
      await actor.setFlag(MODULE_ID, "carryLimitOverride", parseInt(result, 10));
      app.render(false);
    }
  });

  // ── Clear override ────────────────────────────────────────────
  html.find(".enc-clear").on("click", async () => {
    await actor.unsetFlag(MODULE_ID, "carryLimitOverride");
    app.render(false);
  });
}

// ─────────────────────────────────────────────────────────────────
// Warning notification
// ─────────────────────────────────────────────────────────────────
function warnIfOver(actor) {
  if (!actor || !game.settings.get(MODULE_ID, "showWarnings")) return;
  const enc = calcEncumbrance(actor);
  if (enc?.over) {
    ui.notifications.warn(
      `${actor.name} is carrying too much! (${enc.current} / ${enc.max} slots)`
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Re-render open sheets for an actor
// ─────────────────────────────────────────────────────────────────
function rerenderActor(actorId) {
  Object.values(ui.windows)
    .filter(w => (w.actor?.id ?? w.document?.id) === actorId)
    .forEach(w => w.render(false));
}

// ─────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────
Hooks.once("init", () => {

  game.settings.register(MODULE_ID, "strMultiplier", {
    name: "Slots per Strength die",
    hint: "Carry limit = STR dice × this number. Default 5 means a character with 3D STR can carry 15 items. Pips count as fractions (3D+1 ≈ 3.33 dice → 17 slots).",
    scope: "world",
    config: true,
    type: Number,
    default: 5,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, "defaultCarryLimit", {
    name: "Fallback carry limit (if STR not found)",
    hint: "Used when the module cannot read a Strength attribute from the sheet.",
    scope: "world",
    config: true,
    type: Number,
    default: 10,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, "showWarnings", {
    name: "Show encumbrance warnings",
    hint: "Show a popup notification when a character exceeds their carry limit.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  console.log(`${MODULE_ID} | Initialised`);
});

Hooks.on("renderActorSheet", (app, html) => {
  injectEncumbranceBar(app, html);
});

Hooks.on("createItem", (item) => {
  if (item.parent?.documentName !== "Actor") return;
  warnIfOver(item.parent);
  rerenderActor(item.parent.id);
});

Hooks.on("deleteItem", (item) => {
  if (item.parent?.documentName !== "Actor") return;
  rerenderActor(item.parent.id);
});

// No need to watch updateItem — slot count doesn't depend on item fields
