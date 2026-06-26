/**
 * Feelings Search Engine
 *
 * Evaluates parsed query ASTs against loaded card and printing data.
 */

import { PRINTING_FIELDS, NUMERIC_FIELDS, DIRECTIVE_FIELDS, RARITY_ORDER, normalizeRarityLabel, parseBooleanValue } from "./parser.js";

let cards = [];
let printings = [];
let editions = [];
let cardIndex = new Map(); // card_id -> card
let printingsIndex = new Map(); // card_id -> printing[]
let editionIndex = new Map(); // edition_id -> edition

/**
 * Initialize the search engine with card, printing, and edition data.
 */
export function initSearch(cardsData, printingsData, editionsData) {
  cards = cardsData;
  printings = printingsData;
  editions = editionsData || [];

  cardIndex.clear();
  printingsIndex.clear();
  editionIndex.clear();

  for (const edition of editions) {
    editionIndex.set(edition.id, edition);
  }

  for (const card of cards) {
    cardIndex.set(card.id, card);
    // Pre-compute normalized search fields
    card._rules_text_plain = card.rules_text
      ? card.rules_text.replace(/<[^>]*>/g, "")
      : "";
    card._notes_plain = Array.isArray(card.notes)
      ? card.notes.join(" ")
      : "";
  }

  for (const printing of printings) {
    if (!printingsIndex.has(printing.card_id)) {
      printingsIndex.set(printing.card_id, []);
    }
    printingsIndex.get(printing.card_id).push(printing);
    // Normalize artist to string for searching
    printing._artist_str = Array.isArray(printing.artist)
      ? printing.artist.join(", ")
      : printing.artist || "";
    // Pre-compute plain-text printed rules (HTML stripped), null when absent
    printing._printed_rules_plain = printing.printed_rules_text
      ? printing.printed_rules_text.replace(/<[^>]*>/g, "")
      : "";
  }
}

/**
 * Execute a search given a parsed AST.
 * Returns { results, directives, errors }
 * - results: array of { card, printing } objects
 * - directives: { sort, as }
 * - errors: array of error messages
 */
export function executeSearch(ast) {
  const errors = [];
  const directives = { sort: null, as: "cards" };

  if (!ast || ast.groups.length === 0) {
    return { results: [], directives, errors };
  }

  // Extract directives and determine if printing-level search is needed
  let hasPrintingFilter = false;

  for (const group of ast.groups) {
    for (const frag of group.fragments) {
      if (frag.invalid) continue;
      if (DIRECTIVE_FIELDS.has(frag.field)) {
        if (frag.field === "sort") directives.sort = frag.value;
        if (frag.field === "as") directives.as = frag.value || "cards";
      } else if (PRINTING_FIELDS.has(frag.field)) {
        hasPrintingFilter = true;
      }
    }
  }

  // Also check if "as" includes printings
  if (directives.as === "printings" || directives.as === "textprintings") {
    hasPrintingFilter = true;
  }

  // Evaluate each OR group and union the results
  const resultSets = [];

  for (const group of ast.groups) {
    const filters = group.fragments.filter(
      (f) => !f.invalid && !DIRECTIVE_FIELDS.has(f.field)
    );

    if (filters.length === 0) continue;

    let groupResults;
    if (hasPrintingFilter) {
      groupResults = evaluateAtPrintingLevel(filters, errors);
    } else {
      groupResults = evaluateAtCardLevel(filters, errors);
    }
    resultSets.push(groupResults);
  }

  // Union all OR groups (deduplicate by printing id or card id)
  let results = unionResults(resultSets, hasPrintingFilter);

  // Apply sort
  if (directives.sort) {
    results = sortResults(results, directives.sort);
  }

  // Project results based on "as" directive
  results = projectResults(results, directives.as);

  return { results, directives, errors };
}

function evaluateAtCardLevel(filters, errors) {
  let results = [];

  for (const card of cards) {
    const cardPrintings = printingsIndex.get(card.id) || [];
    const latestPrinting = cardPrintings[cardPrintings.length - 1] || null;

    if (matchesAllFilters(card, latestPrinting, filters, errors)) {
      results.push({ card, printing: latestPrinting });
    }
  }

  return results;
}

function evaluateAtPrintingLevel(filters, errors) {
  let results = [];

  for (const printing of printings) {
    const card = cardIndex.get(printing.card_id);
    if (!card) continue;

    if (matchesAllFilters(card, printing, filters, errors)) {
      results.push({ card, printing });
    }
  }

  return results;
}

function matchesAllFilters(card, printing, filters, errors) {
  for (const filter of filters) {
    const matches = matchesFilter(card, printing, filter, errors);
    if (filter.negated ? matches : !matches) {
      return false;
    }
  }
  return true;
}

function matchesFilter(card, printing, filter, errors) {
  const { field, operator, value, valueType } = filter;

  // Special handling for "id" field — matches card or printing ID
  if (field === "id") {
    return (
      matchValue(card.id, operator, value, valueType) ||
      (printing && matchValue(printing.id, operator, value, valueType))
    );
  }

  // Card fields
  if (field === "name") {
    return matchValue(card.name, operator, value, valueType);
  }
  if (field === "color") {
    const lowerValue = value.toLowerCase();
    if (operator === ":" && (lowerValue === "none" || lowerValue === "colorless")) {
      return card.color.length === 0;
    }
    // Expand WUBRG shorthand
    const expanded = expandColorShorthand(lowerValue);
    if (expanded) {
      // Multi-color shorthand (e.g. "wu" -> White and Blue): card must have all specified colors
      const cardColors = card.color.map(c => c.toLowerCase());
      return expanded.every(color => cardColors.includes(color));
    }
    return matchValue(card.color, operator, value, valueType, true);
  }
  if (field === "dice") {
    return matchDice(card.dice, operator, value, valueType);
  }
  if (field === "dice_value") {
    return matchNumeric(card.dice_value, operator, value);
  }
  if (field === "secondary_dice") {
    return matchDice(card.secondary_dice, operator, value, valueType);
  }
  if (field === "secondary_dice_value") {
    return matchNumeric(card.secondary_dice_value, operator, value);
  }
  if (field === "rules_text") {
    const searchValue = substituteCardName(value, card.name);
    return matchValue(card._rules_text_plain, operator, searchValue, valueType);
  }
  if (field === "notes") {
    const searchValue = substituteCardName(value, card.name);
    if (!card.notes || card.notes.length === 0) {
      return value === "" || value === null;
    }
    return card.notes.some((note) =>
      matchValue(note, operator, searchValue, valueType)
    );
  }
  if (field === "timing") {
    const timing = card.timing || [];
    if (value === "" || value === null) {
      return timing.length === 0;
    }
    if (valueType === "regex") {
      return timing.some((t) => matchValue(t, operator, value, valueType));
    }
    // Match against canonical tokens; also accept space-for-underscore (e.g. "in play")
    const normalized = value.toLowerCase().replace(/\s+/g, "_");
    return timing.some((t) => {
      const lower = t.toLowerCase();
      return operator === "=" ? lower === normalized : lower.includes(normalized);
    });
  }
  if (field === "errata") {
    return matchErrata(card.errata, printing ? printing.errata : null, operator, value, valueType);
  }

  // Printing fields (need a printing to match)
  if (!printing) return false;

  if (field === "frame") {
    return matchValue(printing.frame, operator, value, valueType, true);
  }
  if (field === "reminder_icon") {
    return matchValue(printing.reminder_icon || "", operator, value, valueType);
  }
  if (field === "rarity") {
    if (operator === ">" || operator === "<" || operator === ">=" || operator === "<=") {
      return matchRarity(printing.rarity, operator, value);
    }
    return matchValue(printing.rarity, operator, value, valueType, true);
  }
  if (field === "dice_color") {
    return matchValue(printing.dice_color || "", operator, value, valueType, true);
  }
  if (field === "collector_number") {
    return matchNumeric(printing.collector_number, operator, value);
  }
  if (field === "set") {
    const edition = editionIndex.get(printing.edition_id);
    if (!edition) return false;
    return (
      matchValue(edition.set_code, operator, value, valueType, true) ||
      matchValue(edition.edition_name, operator, value, valueType)
    );
  }
  if (field === "treatment") {
    return matchValue(printing.treatment, operator, value, valueType, true);
  }
  if (field === "artist") {
    return matchValue(printing._artist_str, operator, value, valueType);
  }
  if (field === "is_headliner") {
    return matchBoolean(printing.is_headliner, value);
  }
  if (field === "printed_rules_text") {
    if (value === "" || value === null) {
      return !printing.printed_rules_text;
    }
    const searchValue = substituteCardName(value, card.name);
    return matchValue(printing._printed_rules_plain, operator, searchValue, valueType);
  }

  return false;
}

/**
 * Match a boolean field against a query value (true/yes/1, false/no/0, or empty=present).
 */
function matchBoolean(fieldValue, queryValue) {
  const want = parseBooleanValue(queryValue);
  if (want === null) return false;
  return Boolean(fieldValue) === want;
}

/**
 * Match the combined errata of a card and printing against a query.
 * A boolean/empty value tests presence (errata on the card OR its printing);
 * any other value searches the errata notes and field names of both.
 */
function matchErrata(cardErrata, printingErrata, operator, value, valueType) {
  const present = !!(cardErrata || printingErrata);
  const bool = parseBooleanValue(value);
  if (bool !== null) {
    return present === bool;
  }
  if (!present) return false;
  const parts = [];
  for (const e of [cardErrata, printingErrata]) {
    if (e) parts.push(e.note || "", ...(e.fields || []));
  }
  return matchValue(parts.join(" "), operator, value, valueType);
}

const COLOR_SHORTHAND = {
  w: "white",
  u: "blue",
  b: "black",
  r: "red",
  g: "green",
};

/**
 * Expand WUBRG shorthand to full color names.
 * Returns an array of color names if the value is entirely WUBRG letters,
 * or null if it's not a valid shorthand.
 */
function expandColorShorthand(lowerValue) {
  if (lowerValue.length === 0) return null;
  const colors = [];
  for (const ch of lowerValue) {
    if (!COLOR_SHORTHAND[ch]) return null;
    colors.push(COLOR_SHORTHAND[ch]);
  }
  return colors;
}

function matchValue(fieldValue, operator, queryValue, valueType, usePrefix) {
  if (fieldValue == null) fieldValue = "";

  if (valueType === "regex") {
    try {
      const re = new RegExp(queryValue, "i");
      return re.test(fieldValue);
    } catch {
      return false;
    }
  }

  const fieldLower = String(fieldValue).toLowerCase();
  const queryLower = queryValue.toLowerCase();

  if (operator === "=") {
    // Exact match (case insensitive)
    return fieldLower === queryLower;
  }

  // ":" is inclusive/partial match
  if (usePrefix) {
    return fieldLower.startsWith(queryLower);
  }
  return fieldLower.includes(queryLower);
}

function matchDice(fieldValue, operator, queryValue, valueType) {
  if (fieldValue == null) return queryValue === "" || queryValue === null;

  if (valueType === "regex") {
    try {
      const re = new RegExp(queryValue, "i");
      return re.test(fieldValue);
    } catch {
      return false;
    }
  }

  // Normalize dice notation: brackets are optional
  // "[6][1]" == "6 1" == "[6] [1]"
  const normalizeQuery = queryValue.replace(/[\[\]\s]+/g, " ").trim();
  const normalizeField = fieldValue.replace(/[\[\]\s]+/g, " ").trim();

  if (operator === "=") {
    return normalizeField.toLowerCase() === normalizeQuery.toLowerCase();
  }

  return normalizeField.toLowerCase().includes(normalizeQuery.toLowerCase());
}

function matchNumeric(fieldValue, operator, queryValue) {
  const numQuery = parseFloat(queryValue);
  const numField = fieldValue != null ? fieldValue : null;

  if (isNaN(numQuery)) return false;
  if (numField == null) return false;

  switch (operator) {
    case ":":
    case "=":
      return numField === numQuery;
    case ">":
      return numField > numQuery;
    case "<":
      return numField < numQuery;
    case ">=":
      return numField >= numQuery;
    case "<=":
      return numField <= numQuery;
    default:
      return numField === numQuery;
  }
}

function matchRarity(fieldValue, operator, queryValue) {
  const queryOrder = getRarityOrder(queryValue);
  if (!fieldValue) return false;
  const fieldOrder = RARITY_ORDER[fieldValue.toLowerCase()] ?? null;

  if (queryOrder === null || fieldOrder === null) return false;

  switch (operator) {
    case ">":
      return fieldOrder > queryOrder;
    case "<":
      return fieldOrder < queryOrder;
    case ">=":
      return fieldOrder >= queryOrder;
    case "<=":
      return fieldOrder <= queryOrder;
    default:
      return false;
  }
}

function getRarityOrder(value) {
  const rarityName = normalizeRarityLabel(value);
  return RARITY_ORDER[rarityName] ?? null;
}

function substituteCardName(value, cardName) {
  return value.replace(/~/g, cardName);
}

function unionResults(resultSets, isPrintingLevel) {
  if (resultSets.length === 0) return [];
  if (resultSets.length === 1) return resultSets[0];

  const seen = new Set();
  const results = [];

  for (const set of resultSets) {
    for (const r of set) {
      const key = isPrintingLevel
        ? (r.printing?.id || r.card.id)
        : r.card.id;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(r);
      }
    }
  }

  return results;
}

function sortResults(results, sortSpec) {
  let field = sortSpec;
  let reverse = false;

  if (field.startsWith("-")) {
    reverse = true;
    field = field.slice(1);
  }

  results.sort((a, b) => {
    const aVal = getSortValue(a, field);
    const bVal = getSortValue(b, field);

    let cmp = 0;
    if (aVal == null && bVal == null) cmp = 0;
    else if (aVal == null) cmp = 1;
    else if (bVal == null) cmp = -1;
    else if (typeof aVal === "number" && typeof bVal === "number") {
      cmp = aVal - bVal;
    } else {
      cmp = String(aVal).localeCompare(String(bVal));
    }

    return reverse ? -cmp : cmp;
  });

  return results;
}

function getSortValue(result, field) {
  const { card, printing } = result;

  // Card fields
  if (field === "name") return card.name;
  if (field === "color") return card.color;
  if (field === "dice_value" || field === "dval") return card.dice_value;
  if (field === "secondary_dice_value") return card.secondary_dice_value;

  // Printing fields
  if (printing) {
    if (field === "rarity") {
    return printing.rarity ? (RARITY_ORDER[printing.rarity.toLowerCase()] ?? 0) : 0;
    }
    if (field === "collector_number" || field === "cn")
      return printing.collector_number;
    if (field === "set") {
      const edition = editionIndex.get(printing.edition_id);
      return edition ? edition.set_code : "";
    }
    if (field === "artist") return printing._artist_str;
    if (field === "frame") return printing.frame;
  }

  return card.name; // fallback
}

function projectResults(results, asMode) {
  if (asMode === "printings" || asMode === "textprintings") {
    // Show all printings for matching cards
    const expanded = [];
    const seenCards = new Set();

    for (const r of results) {
      if (seenCards.has(r.card.id)) continue;
      seenCards.add(r.card.id);

      const allPrintings = printingsIndex.get(r.card.id) || [];
      for (const p of allPrintings) {
        expanded.push({ card: r.card, printing: p });
      }
    }
    return expanded;
  }

  if (asMode === "cards" || asMode === "text") {
    // Deduplicate to one result per card, keeping the first matched printing
    const seen = new Set();
    const deduped = [];

    for (const r of results) {
      if (seen.has(r.card.id)) continue;
      seen.add(r.card.id);
      deduped.push(r);
    }
    return deduped;
  }

  return results;
}

/**
 * Get the edition for a printing.
 */
export function getEditionForPrinting(printing) {
  if (!printing) return null;
  return editionIndex.get(printing.edition_id) || null;
}

/**
 * Get all printings for a card ID.
 */
export function getPrintingsForCard(cardId) {
  return printingsIndex.get(cardId) || [];
}

/**
 * Get a card by ID.
 */
export function getCardById(cardId) {
  return cardIndex.get(cardId) || null;
}

/**
 * Find a result (card + printing) by printing ID.
 */
export function getByPrintingId(printingId) {
  for (const printing of printings) {
    if (printing.id === printingId) {
      const card = cardIndex.get(printing.card_id);
      return card ? { card, printing } : null;
    }
  }
  return null;
}
