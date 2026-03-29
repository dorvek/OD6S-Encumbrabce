/**
 * OD6S Encumbrance Tracker v1.3
 *
 * - Weapons count as 1 slot (toggleable)
 * - Armour counts as 1 slot (toggleable)
 * - Gear/equipment counts as 0.5 slots (toggleable, and the half-slot value is configurable)
 * - Carry limit = STR dice × multiplier, overridable per character
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
// Item type classification
// OD6S item types: "weapon", "armor", "equipment" (gear),
// plus passive types we always ignore.
// ─────────────────────────────────────────────────────────────────
const ALWAYS_IGNORED = new Set([
  "ability", "advantage", "disadvantage", "special", "specialability",
  "power", "forcepower", "force", "skill", "trait", "feature",
  "species", "career", "extranormal", "manifestation"
]);

// Returns the slot cost for a single item based on current settings,
// or 0 if the item should not be counted.
function slotCostForItem(item) {
  const type = (item.type ?? "").toLowerCase();

  if (ALWAYS_IGNORED.has(type)) return 0;

  // Weapons
  if (type === "weapon" || type === "rangedweapon" || type === "meleeweapon") {
    return game.settings.get(MODULE_ID, "countWeapons") ? 1 : 0;
  }

  // Armour
  if (type === "armor" || type === "armour") {
    return game.settings.get(MODULE_ID, "countArmor") ? 1 : 0;
  }

  // Gear / equipment — counts as a configurable fraction (default 0.5)
  if (type === "equipment" || type === "gear" || type === "item" || type === "misc") {
    if (!game.settings.get(MODULE_ID, "countGear")) return 0;
    return game.settings.get(MODULE_ID, "gearSlotCost");
  }

  // Anything else physical that we haven't classified — count as 1 by default
  // so nothing sneaks through uncounted
  return 1;
}

// ─────────────────────────────────────────────────────────────────
// Core encumbrance calculation
// ─────────────────────────────────────────────────────────────────
function calcEncumbrance(actor) {
  if (!actor) return null;

  let totalSlots = 0;
  for (const item of actor.items) {
    totalSlots += slotCostForItem(item);
  }
  totalSlots = Math.round(totalSlots * 10) / 10; // round to 1 decimal place

  // Carry limit — per-character override wins, otherwise STR × multiplier
  const override = actor.getFlag(MODULE_ID, "carryLimitOverride");
  let carryLimit;

  if (override !== undefined && override !== null && override !== "") {
    carryLimit = parseFloat(override);
  } else {
    const strDice = getStrengthDice(actor);
    const multiplier = game.settings.get(MODULE_ID, "strMultiplier");
    carryLimit = strDice > 0
      ? Math.round(strDice * multiplier * 10) / 10
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

  const isGM       = game.user.isGM;
  const overClass   = enc.over ? "enc-over" : "";
  const overText    = enc.over ? " ⚠ Over limit!" : "";
  const hasOverride = actor.getFlag(MODULE_ID, "carryLimitOverride") != null;
  const sourceLabel = hasOverride ? " (manual)" : " (from STR)";

  // Build a small legend showing which categories are active
  const parts = [];
  if (game.settings.get(MODULE_ID, "countWeapons")) parts.push("weapons: 1 slot");
  if (game.settings.get(MODULE_ID, "countArmor"))   parts.push("armour: 1 slot");
  if (game.settings.get(MODULE_ID, "countGear"))    parts.push(`gear: ${game.settings.get(MODULE_ID, "gearSlotCost")} slot`);
  const legend = parts.length ? `<span class="enc-legend">${parts.join(" · ")}</span>` : "";

  // Edit/clear buttons only visible to the GM
  const gmButtons = isGM ? `
    <a class="enc-edit" title="Set a manual carry limit (overrides STR)">✎</a>
    ${hasOverride ? `<a class="enc-clear" title="Clear override — use STR again">✕</a>` : ""}
  ` : "";

  const barHtml = `
    <div class="enc-tracker ${overClass}" id="enc-tracker-${actor.id}">
      <div class="enc-label">
        <span class="enc-text">
          Slots: <strong>${enc.current}</strong> / ${enc.max}${sourceLabel}${overText}
        </span>
        ${gmButtons}
      </div>
      <div class="enc-bar-bg">
        <div class="enc-bar-fill ${overClass}" style="width:${enc.pct.toFixed(1)}%"></div>
      </div>
      ${legend}
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

  // Edit/clear handlers — GM only
  if (isGM) {
    html.find(".enc-edit").on("click", async () => {
      const current = actor.getFlag(MODULE_ID, "carryLimitOverride") ?? enc.max;
      const result = await Dialog.prompt({
        title: "Set Carry Limit Override",
        content: `
          <p>Enter a fixed slot limit for <strong>${actor.name}</strong>.</p>
          <p style="font-size:0.85em;color:#888">Click ✕ on the sheet to go back to automatic (STR-based).</p>
          <input type="number" id="enc-limit-input" value="${current}"
                 min="1" step="0.5" style="width:100%;margin-top:4px">
        `,
        callback: (html) => html.find("#enc-limit-input").val(),
        rejectClose: false
      });
      if (result !== null && result !== undefined && result !== "") {
        await actor.setFlag(MODULE_ID, "carryLimitOverride", parseFloat(result));
        app.render(false);
      }
    });

    html.find(".enc-clear").on("click", async () => {
      await actor.unsetFlag(MODULE_ID, "carryLimitOverride");
      app.render(false);
    });
  }
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
// Settings registration
// ─────────────────────────────────────────────────────────────────
Hooks.once("init", () => {

  // ── What counts ──────────────────────────────────────────────
  game.settings.register(MODULE_ID, "countWeapons", {
    name: "Count weapons",
    hint: "Each weapon in the inventory counts as 1 slot.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, "countArmor", {
    name: "Count armour",
    hint: "Each piece of armour in the inventory counts as 1 slot.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, "countGear", {
    name: "Count gear / equipment",
    hint: "Equipment and misc gear items count towards slots (at the fraction set below).",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: false
  });

  game.settings.register(MODULE_ID, "gearSlotCost", {
    name: "Gear slot cost",
    hint: "How many slots each gear/equipment item uses. Default 0.5 means two gear items = 1 slot. Set to 1 to make gear count the same as weapons.",
    scope: "world",
    config: true,
    type: Number,
    default: 0.5,
    requiresReload: false
  });

  // ── Carry limit ───────────────────────────────────────────────
  game.settings.register(MODULE_ID, "strMultiplier", {
    name: "Slots per Strength die",
    hint: "Carry limit = STR dice × this number. Default 5 means a character with 3D STR can carry 15 slots worth of gear.",
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

  // ── Warnings ─────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────
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
