/**
 * OD6S Encumbrance Tracker v1.1
 *
 * Per-category slot costs (weapons, armour, gear each configurable).
 * Optional scale multiplier — higher scale items take more slots.
 * Carry limit = STR dice × multiplier, overridable per character.
 * Bag label on equipped items adds bonus slots.
 * Edit/clear buttons visible to GM only.
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
// Item types we always ignore (passives, abilities, etc.)
// ─────────────────────────────────────────────────────────────────
const ALWAYS_IGNORED = new Set([
  "ability", "advantage", "disadvantage", "special", "specialability",
  "power", "forcepower", "force", "skill", "trait", "feature",
  "species", "career", "extranormal", "manifestation"
]);

// ─────────────────────────────────────────────────────────────────
// Scale multiplier
// ─────────────────────────────────────────────────────────────────
function scaleMultiplier(item) {
  if (!game.settings.get(MODULE_ID, "useScale")) return 1;

  const scale = parseInt(
    item.system?.scale?.score ?? item.system?.scale ?? item.system?.itemscale ?? 0,
    10
  );
  if (isNaN(scale)) return 1;

  const key = `scaleMultiplier${Math.min(scale, 4)}`;
  return game.settings.get(MODULE_ID, key) ?? 1;
}

// ─────────────────────────────────────────────────────────────────
// Slot cost for a single item entry
// ─────────────────────────────────────────────────────────────────
function slotCostForItem(item) {
  const type = (item.type ?? "").toLowerCase();

  if (ALWAYS_IGNORED.has(type)) return 0;

  let baseCost = 0;
  let useQty = false;

  if (type === "weapon" || type === "rangedweapon" || type === "meleeweapon") {
    if (!game.settings.get(MODULE_ID, "countWeapons")) return 0;
    baseCost = game.settings.get(MODULE_ID, "weaponSlotCost");
    useQty = game.settings.get(MODULE_ID, "weaponCountQty");

  } else if (type === "armor" || type === "armour") {
    if (!game.settings.get(MODULE_ID, "countArmor")) return 0;
    baseCost = game.settings.get(MODULE_ID, "armorSlotCost");
    useQty = game.settings.get(MODULE_ID, "armorCountQty");

  } else if (type === "equipment" || type === "gear" || type === "item" || type === "misc") {
    if (!game.settings.get(MODULE_ID, "countGear")) return 0;
    baseCost = game.settings.get(MODULE_ID, "gearSlotCost");
    useQty = game.settings.get(MODULE_ID, "gearCountQty");

  } else {
    baseCost = 1;
    useQty = false;
  }

  // Per-item slot override via system.labels.Slot
  const labelSlot = item.system?.labels?.Slot ?? item.system?.labels?.slot ?? "";
  if (labelSlot !== "" && !isNaN(parseFloat(labelSlot))) {
    baseCost = parseFloat(labelSlot);
  }

  const qty = useQty ? Math.max(1, parseInt(item.system?.quantity ?? item.system?.qty ?? 1)) : 1;
  return baseCost * qty * scaleMultiplier(item);
}

// ─────────────────────────────────────────────────────────────────
// Core encumbrance calculation
// ─────────────────────────────────────────────────────────────────
function calcEncumbrance(actor) {
  if (!actor) return null;

  let totalSlots = 0;
  let bagBonus   = 0;

  for (const item of actor.items) {
    totalSlots += slotCostForItem(item);

    // Bag label on equipped items adds bonus slots to carry limit
    const isEquipped = item.system?.equipped?.value ?? false;
    if (isEquipped) {
      const bagVal = item.system?.labels?.Bag ?? item.system?.labels?.bag ?? "";
      if (bagVal !== "" && !isNaN(parseFloat(bagVal))) {
        bagBonus += parseFloat(bagVal);
      }
    }
  }

  totalSlots = Math.round(totalSlots * 10) / 10;
  bagBonus   = Math.round(bagBonus   * 10) / 10;

  const override = actor.getFlag(MODULE_ID, "carryLimitOverride");
  let baseLimit;

  if (override !== undefined && override !== null && override !== "") {
    baseLimit = parseFloat(override);
  } else {
    const strDice = getStrengthDice(actor);
    const multiplier = game.settings.get(MODULE_ID, "strMultiplier");
    baseLimit = strDice > 0
      ? Math.round(strDice * multiplier * 10) / 10
      : game.settings.get(MODULE_ID, "defaultCarryLimit");
  }

  const carryLimit = Math.round((baseLimit + bagBonus) * 10) / 10;

  return {
    current:   totalSlots,
    max:       carryLimit,
    baseLimit,
    bagBonus,
    over:      totalSlots > carryLimit,
    pct:       Math.min((totalSlots / carryLimit) * 100, 100)
  };
}

// ─────────────────────────────────────────────────────────────────
// Inject bar into actor sheet
// ─────────────────────────────────────────────────────────────────
function injectEncumbranceBar(app, html) {
  const actor = app.actor ?? app.document;
  if (!actor || actor.type === "npc" || actor.type === "vehicle") return;

  const enc = calcEncumbrance(actor);
  if (!enc) return;

  const isGM        = game.user.isGM;
  const overClass   = enc.over ? "enc-over" : "";
  const overText    = enc.over ? " ⚠ Over limit!" : "";
  const hasOverride = actor.getFlag(MODULE_ID, "carryLimitOverride") != null;
  const sourceLabel = hasOverride ? " (manual)" : " (from STR)";
  const bagText     = enc.bagBonus > 0 ? ` +${enc.bagBonus} bag` : "";

  const parts = [];
  if (game.settings.get(MODULE_ID, "countWeapons")) {
    const qtyLabel = game.settings.get(MODULE_ID, "weaponCountQty") ? " ×qty" : "";
    parts.push(`weapons: ${game.settings.get(MODULE_ID, "weaponSlotCost")} slot${qtyLabel}`);
  }
  if (game.settings.get(MODULE_ID, "countArmor")) {
    const qtyLabel = game.settings.get(MODULE_ID, "armorCountQty") ? " ×qty" : "";
    parts.push(`armour: ${game.settings.get(MODULE_ID, "armorSlotCost")} slot${qtyLabel}`);
  }
  if (game.settings.get(MODULE_ID, "countGear")) {
    const qtyLabel = game.settings.get(MODULE_ID, "gearCountQty") ? " ×qty" : "";
    parts.push(`gear: ${game.settings.get(MODULE_ID, "gearSlotCost")} slot${qtyLabel}`);
  }
  if (game.settings.get(MODULE_ID, "useScale")) {
    const sm = [0,1,2,3,4].map(i => game.settings.get(MODULE_ID, `scaleMultiplier${i}`));
    parts.push(`scale ×${sm[0]}/${sm[1]}/${sm[2]}/${sm[3]}/${sm[4]}`);
  }
  const legend = parts.length
    ? `<span class="enc-legend">${parts.join(" · ")}</span>`
    : "";

  const gmButtons = isGM ? `
    <a class="enc-edit" title="Set a manual carry limit (overrides STR)">✎</a>
    ${hasOverride ? `<a class="enc-clear" title="Clear override — use STR again">✕</a>` : ""}
  ` : "";

  const barHtml = `
    <div class="enc-tracker ${overClass}" id="enc-tracker-${actor.id}">
      <div class="enc-label">
        <span class="enc-text">
          Slots: <strong>${enc.current}</strong> / ${enc.max}${sourceLabel}${bagText}${overText}
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
    ".sheet-body", ".tab.active", ".tab[data-tab='main']",
    ".tab[data-tab='inventory']", "form.sheet", "form"
  ];
  let inserted = false;
  for (const sel of targets) {
    const el = html.find(sel).first();
    if (el.length) { el.prepend(barHtml); inserted = true; break; }
  }
  if (!inserted) html.append(barHtml);

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
// Settings
// ─────────────────────────────────────────────────────────────────
Hooks.once("init", () => {

  game.settings.register(MODULE_ID, "countWeapons", {
    name: "Count weapons",
    hint: "Weapons take up slots in the carry limit.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "weaponSlotCost", {
    name: "Weapon slot cost",
    hint: "How many slots each weapon takes. Default 1.",
    scope: "world", config: true, type: Number, default: 1
  });

  game.settings.register(MODULE_ID, "weaponCountQty", {
    name: "Weapons: count by quantity",
    hint: "If on, a stack of 3 weapons uses 3× the slot cost.",
    scope: "world", config: true, type: Boolean, default: false
  });

  game.settings.register(MODULE_ID, "countArmor", {
    name: "Count armour",
    hint: "Armour takes up slots in the carry limit.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "armorSlotCost", {
    name: "Armour slot cost",
    hint: "How many slots each armour piece takes. Default 1.",
    scope: "world", config: true, type: Number, default: 1
  });

  game.settings.register(MODULE_ID, "armorCountQty", {
    name: "Armour: count by quantity",
    hint: "If on, a stack of 3 armour pieces uses 3× the slot cost.",
    scope: "world", config: true, type: Boolean, default: false
  });

  game.settings.register(MODULE_ID, "countGear", {
    name: "Count gear / equipment",
    hint: "General equipment and misc gear takes up slots.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "gearSlotCost", {
    name: "Gear slot cost",
    hint: "How many slots each gear item takes. Default 0.5 (two items = 1 slot).",
    scope: "world", config: true, type: Number, default: 0.5
  });

  game.settings.register(MODULE_ID, "gearCountQty", {
    name: "Gear: count by quantity",
    hint: "If on, 11 medpacks uses 11× the slot cost.",
    scope: "world", config: true, type: Boolean, default: true
  });

  game.settings.register(MODULE_ID, "useScale", {
    name: "Use item scale for slot cost",
    hint: "When enabled, higher-scale items take more slots.",
    scope: "world", config: true, type: Boolean, default: false
  });

  game.settings.register(MODULE_ID, "scaleMultiplier0", {
    name: "Scale 0 slot multiplier (character scale)",
    hint: "Slot multiplier for scale 0 items. Default 1.",
    scope: "world", config: true, type: Number, default: 1
  });

  game.settings.register(MODULE_ID, "scaleMultiplier1", {
    name: "Scale 1 slot multiplier (speeder/walker scale)",
    hint: "Slot multiplier for scale 1 items. Default 2.",
    scope: "world", config: true, type: Number, default: 2
  });

  game.settings.register(MODULE_ID, "scaleMultiplier2", {
    name: "Scale 2 slot multiplier (starfighter scale)",
    hint: "Slot multiplier for scale 2 items. Default 4.",
    scope: "world", config: true, type: Number, default: 4
  });

  game.settings.register(MODULE_ID, "scaleMultiplier3", {
    name: "Scale 3 slot multiplier (capital ship scale)",
    hint: "Slot multiplier for scale 3 items. Default 8.",
    scope: "world", config: true, type: Number, default: 8
  });

  game.settings.register(MODULE_ID, "scaleMultiplier4", {
    name: "Scale 4+ slot multiplier (death star scale)",
    hint: "Slot multiplier for scale 4 and above items. Default 16.",
    scope: "world", config: true, type: Number, default: 16
  });

  game.settings.register(MODULE_ID, "strMultiplier", {
    name: "Slots per Strength die",
    hint: "Carry limit = STR dice × this number. Default 5 means 3D STR = 15 slots.",
    scope: "world", config: true, type: Number, default: 5
  });

  game.settings.register(MODULE_ID, "defaultCarryLimit", {
    name: "Fallback carry limit (if STR not found)",
    hint: "Used when the module cannot read Strength from the sheet.",
    scope: "world", config: true, type: Number, default: 10
  });

  game.settings.register(MODULE_ID, "showWarnings", {
    name: "Show encumbrance warnings",
    hint: "Show a popup when a character exceeds their carry limit.",
    scope: "world", config: true, type: Boolean, default: true
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
