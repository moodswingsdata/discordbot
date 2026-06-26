/**
 * Feelings Query Language Parser
 *
 * Uses Chevrotain to tokenize and parse the Feelings query language into an AST.
 * Grammar:
 *   Query     → OrGroup (OR OrGroup)*
 *   OrGroup   → Fragment+
 *   Fragment  → NEGATE? (KeyedFragment | BareFragment)
 *   KeyedFragment → KEYWORD OPERATOR VALUE
 *   BareFragment  → VALUE
 */

import {
  createToken,
  Lexer,
  CstParser,
} from "./chevrotain.min.mjs";

// --- Tokens ---

const WhiteSpace = createToken({
  name: "WhiteSpace",
  pattern: /\s+/,
  group: Lexer.SKIPPED,
});

const Or = createToken({ name: "Or", pattern: /or\b/i });
const Negate = createToken({ name: "Negate", pattern: /-(?=\w)/ });

const GTE = createToken({ name: "GTE", pattern: />=|=>/ });
const LTE = createToken({ name: "LTE", pattern: /<=|=</ });
const GT = createToken({ name: "GT", pattern: />/ });
const LT = createToken({ name: "LT", pattern: /</ });
const Equals = createToken({ name: "Equals", pattern: /=/ });
const Colon = createToken({ name: "Colon", pattern: /:/ });

const QuotedString = createToken({
  name: "QuotedString",
  pattern: /"[^"]*"/,
});

const RegexLiteral = createToken({
  name: "RegexLiteral",
  pattern: /\/[^/]+\//,
});

// A keyword is a known identifier followed by an operator
// We handle this via longer_alt and the parser grammar
const BareWord = createToken({
  name: "BareWord",
  pattern: /[^\s:=<>"/-][^\s:=<>"/ ]*/,
});

const allTokens = [
  WhiteSpace,
  Or,
  Negate,
  GTE,
  LTE,
  GT,
  LT,
  Equals,
  Colon,
  QuotedString,
  RegexLiteral,
  BareWord,
];

const FeelingsLexer = new Lexer(allTokens);

// --- Known keywords and aliases ---
const KEYWORD_MAP = {
  name: "name",
  n: "name",
  id: "id",
  color: "color",
  c: "color",
  dice: "dice",
  d: "dice",
  dice_value: "dice_value",
  dval: "dice_value",
  secondary_dice: "secondary_dice",
  dd: "secondary_dice",
  "2dice": "secondary_dice",
  secondary_dice_value: "secondary_dice_value",
  "2val": "secondary_dice_value",
  "2dval": "secondary_dice_value",
  ddval: "secondary_dice_value",
  rules: "rules_text",
  t: "rules_text",
  notes: "notes",
  note: "notes",
  rulings: "notes",
  rul: "notes",
  timing: "timing",
  tm: "timing",
  errata: "errata",
  err: "errata",
  frame: "frame",
  fr: "frame",
  reminder: "reminder_icon",
  rem: "reminder_icon",
  rarity: "rarity",
  r: "rarity",
  dicecolor: "dice_color",
  dc: "dice_color",
  collectornumber: "collector_number",
  cn: "collector_number",
  set: "set",
  treatment: "treatment",
  tr: "treatment",
  artist: "artist",
  a: "artist",
  headliner: "is_headliner",
  hl: "is_headliner",
  printedrules: "printed_rules_text",
  printed: "printed_rules_text",
  pt: "printed_rules_text",
  sort: "sort",
  as: "as",
};

const PRINTING_FIELDS = new Set([
  "frame",
  "reminder_icon",
  "rarity",
  "dice_color",
  "collector_number",
  "set",
  "treatment",
  "artist",
  "is_headliner",
  "printed_rules_text",
]);

const NUMERIC_FIELDS = new Set([
  "dice_value",
  "secondary_dice_value",
  "collector_number",
]);

const DIRECTIVE_FIELDS = new Set(["sort", "as"]);

// --- Parser ---
class FeelingsParser extends CstParser {
  constructor() {
    super(allTokens);
    const $ = this;

    $.RULE("query", () => {
      $.SUBRULE($.orGroup);
      $.MANY(() => {
        $.CONSUME(Or);
        $.SUBRULE2($.orGroup);
      });
    });

    $.RULE("orGroup", () => {
      $.AT_LEAST_ONE(() => {
        $.SUBRULE($.fragment);
      });
    });

    $.RULE("fragment", () => {
      $.OPTION(() => {
        $.CONSUME(Negate);
      });
      $.OR([
        {
          GATE: () => {
            // Look ahead: if BareWord is followed by an operator, it's keyed
            const first = $.LA(1);
            if (first.tokenType === BareWord) {
              const second = $.LA(2);
              return (
                second.tokenType === Colon ||
                second.tokenType === Equals ||
                second.tokenType === GTE ||
                second.tokenType === LTE ||
                second.tokenType === GT ||
                second.tokenType === LT
              );
            }
            return false;
          },
          ALT: () => $.SUBRULE($.keyedFragment),
        },
        { ALT: () => $.SUBRULE($.bareFragment) },
      ]);
    });

    $.RULE("keyedFragment", () => {
      $.CONSUME(BareWord, { LABEL: "keyword" });
      $.OR([
        { ALT: () => $.CONSUME(Colon) },
        { ALT: () => $.CONSUME(Equals) },
        { ALT: () => $.CONSUME(GTE) },
        { ALT: () => $.CONSUME(LTE) },
        { ALT: () => $.CONSUME(GT) },
        { ALT: () => $.CONSUME(LT) },
      ]);
      $.OPTION(() => {
        $.SUBRULE($.value);
      });
    });

    $.RULE("bareFragment", () => {
      $.OR([
        { ALT: () => $.CONSUME(QuotedString) },
        { ALT: () => $.CONSUME(RegexLiteral) },
        { ALT: () => $.CONSUME(BareWord) },
      ]);
    });

    $.RULE("value", () => {
      $.OPTION(() => {
        $.CONSUME(Negate);
      });
      $.OR([
        { ALT: () => $.CONSUME(QuotedString) },
        { ALT: () => $.CONSUME(RegexLiteral) },
        { ALT: () => $.CONSUME(BareWord) },
        { ALT: () => $.CONSUME(Or) },
      ]);
    });

    this.performSelfAnalysis();
  }
}

const parser = new FeelingsParser();

// --- AST Visitor ---
function buildAST(cst) {
  return visitQuery(cst);
}

function visitQuery(node) {
  const groups = [];
  if (node.children.orGroup) {
    for (const og of node.children.orGroup) {
      groups.push(visitOrGroup(og));
    }
  }
  return { type: "query", groups };
}

function visitOrGroup(node) {
  const fragments = [];
  if (node.children.fragment) {
    for (const f of node.children.fragment) {
      fragments.push(visitFragment(f));
    }
  }
  return { type: "orGroup", fragments };
}

function visitFragment(node) {
  const negated = !!(node.children.Negate && node.children.Negate.length > 0);

  if (node.children.keyedFragment && node.children.keyedFragment.length > 0) {
    const kf = node.children.keyedFragment[0];
    return visitKeyedFragment(kf, negated);
  }

  if (node.children.bareFragment && node.children.bareFragment.length > 0) {
    const bf = node.children.bareFragment[0];
    return visitBareFragment(bf, negated);
  }

  return { type: "fragment", field: "name", operator: ":", value: "", negated };
}

function visitKeyedFragment(node, negated) {
  const keywordToken = node.children.keyword[0];
  const rawKeyword = keywordToken.image.toLowerCase();

  // Determine operator
  let operator = ":";
  if (node.children.Colon) operator = ":";
  else if (node.children.Equals) operator = "=";
  else if (node.children.GTE) operator = ">=";
  else if (node.children.LTE) operator = "<=";
  else if (node.children.GT) operator = ">";
  else if (node.children.LT) operator = "<";

  // Determine value
  let value = "";
  let valueType = "string";
  if (node.children.value && node.children.value.length > 0) {
    const v = node.children.value[0].children;
    const hasNegate = !!(v.Negate && v.Negate.length > 0);
    if (v.QuotedString && v.QuotedString.length > 0) {
      value = v.QuotedString[0].image.slice(1, -1);
      valueType = "quoted";
    } else if (v.RegexLiteral && v.RegexLiteral.length > 0) {
      value = v.RegexLiteral[0].image.slice(1, -1);
      valueType = "regex";
    } else if (v.BareWord && v.BareWord.length > 0) {
      value = v.BareWord[0].image;
      valueType = "string";
    } else if (v.Or && v.Or.length > 0) {
      value = v.Or[0].image;
      valueType = "string";
    }
    if (hasNegate) {
      value = "-" + value;
    }
  }

  // Resolve keyword
  const field = KEYWORD_MAP[rawKeyword];
  if (!field) {
    return {
      type: "fragment",
      field: null,
      operator,
      value,
      valueType,
      negated,
      invalid: true,
      rawKeyword,
    };
  }

  return { type: "fragment", field, operator, value, valueType, negated };
}

function visitBareFragment(node, negated) {
  let value = "";
  let valueType = "string";
  const c = node.children;

  if (c.QuotedString && c.QuotedString.length > 0) {
    value = c.QuotedString[0].image.slice(1, -1);
    valueType = "quoted";
  } else if (c.RegexLiteral && c.RegexLiteral.length > 0) {
    value = c.RegexLiteral[0].image.slice(1, -1);
    valueType = "regex";
  } else if (c.BareWord && c.BareWord.length > 0) {
    value = c.BareWord[0].image;
    valueType = "string";
  }

  return { type: "fragment", field: "name", operator: ":", value, valueType, negated };
}

// --- Public API ---

/**
 * Parse a query string and return an AST.
 * Returns { ast, errors } where errors is an array of { message } objects.
 */
export function parseQuery(input) {
  const errors = [];

  if (!input || !input.trim()) {
    return { ast: { type: "query", groups: [] }, errors };
  }

  const lexResult = FeelingsLexer.tokenize(input);
  if (lexResult.errors.length > 0) {
    for (const e of lexResult.errors) {
      errors.push({ message: `Lexer error: ${e.message}` });
    }
  }

  parser.input = lexResult.tokens;
  const cst = parser.query();

  if (parser.errors.length > 0) {
    for (const e of parser.errors) {
      errors.push({ message: `Parse error: ${e.message}` });
    }
  }

  const ast = buildAST(cst);

  return { ast, errors };
}

const FIELD_LABELS = {
  name: "name",
  id: "ID",
  color: "color",
  dice: "dice",
  dice_value: "dice value",
  secondary_dice: "secondary dice",
  secondary_dice_value: "secondary dice value",
  rules_text: "rules text",
  notes: "notes",
  timing: "timing",
  errata: "errata",
  frame: "frame",
  reminder_icon: "reminder icon",
  rarity: "rarity",
  dice_color: "dice color",
  collector_number: "collector number",
  set: "set",
  treatment: "treatment",
  artist: "artist",
  is_headliner: "headliner",
  printed_rules_text: "printed rules text",
};

const AS_LABELS = {
  cards: "cards",
  printings: "printings",
  text: "text",
  textprintings: "text printings",
};
const DEFAULT_AS_VALUE = "cards";

const COLOR_LABELS = {
  w: "white",
  u: "blue",
  b: "black",
  r: "red",
  g: "green",
};

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, "mythic rare": 3 };
const RARITY_NAMES = Object.keys(RARITY_ORDER);

// Fields whose values are free text (quoted in summaries, "contains" matching).
const TEXT_FIELDS = new Set([
  "name",
  "rules_text",
  "notes",
  "printed_rules_text",
]);

// Fields interpreted as booleans (presence/absence) in queries.
const BOOLEAN_FIELDS = new Set(["is_headliner", "errata"]);

const TRUE_VALUES = new Set(["", "true", "yes", "y", "1", "t"]);
const FALSE_VALUES = new Set(["false", "no", "n", "0", "f"]);

/**
 * Interpret a query value as a boolean. An empty value means "true" (present).
 * Returns true, false, or null when the value isn't a recognized boolean.
 */
function parseBooleanValue(value) {
  const lower = (value || "").toLowerCase();
  if (TRUE_VALUES.has(lower)) return true;
  if (FALSE_VALUES.has(lower)) return false;
  return null;
}

function describeBoolean(field, value, valueType, negated) {
  const label = formatFieldLabel(field);
  const bool = parseBooleanValue(value);
  // For errata, a non-boolean value is treated as a text search of the note.
  if (bool === null) {
    const formattedValue = `"${value}"`;
    return negated
      ? `${label} note does not contain ${formattedValue}`
      : `${label} note contains ${formattedValue}`;
  }
  const positive = negated ? !bool : bool;
  if (field === "errata") {
    return positive ? "has errata" : "has no errata";
  }
  return positive ? `is a ${label}` : `is not a ${label}`;
}

const RARITY_ALIASES = {
  c: "common",
  common: "common",
  u: "uncommon",
  uncommon: "uncommon",
  r: "rare",
  rare: "rare",
  m: "mythic rare",
  my: "mythic rare",
  mythic: "mythic rare",
  "mythic rare": "mythic rare",
};

function normalizeColorLabel(value) {
  const lowerValue = value.toLowerCase();
  if (lowerValue === "none" || lowerValue === "colorless") return "colorless";
  if (lowerValue.length > 0) {
    const colors = [];
    for (const ch of lowerValue) {
      if (!COLOR_LABELS[ch]) return lowerValue;
      colors.push(COLOR_LABELS[ch]);
    }
    return colors.join(" and ");
  }
  return lowerValue;
}

function normalizeRarityLabel(value) {
  const lowerValue = value.toLowerCase();
  if (RARITY_ALIASES[lowerValue]) return RARITY_ALIASES[lowerValue];
  const label = RARITY_NAMES.find((candidate) =>
    candidate.startsWith(lowerValue)
  );
  if (label) return label;
  return lowerValue;
}

function formatValue(field, value, valueType) {
  if (valueType === "regex") return `/${value}/`;
  if (field === "color") return normalizeColorLabel(value);
  if (field === "rarity") return normalizeRarityLabel(value);
  if (TEXT_FIELDS.has(field)) {
    return `"${value}"`;
  }
  return value.toLowerCase();
}

function formatFieldLabel(field) {
  return FIELD_LABELS[field] || field.replace(/_/g, " ");
}

function formatSortValue(value) {
  const descending = value.startsWith("-");
  const rawField = descending ? value.slice(1) : value;
  const resolvedField = KEYWORD_MAP[rawField.toLowerCase()] || rawField;
  const label = formatFieldLabel(resolvedField);
  return descending ? `${label} descending` : label;
}

function describeDirective(fragment) {
  if (fragment.field === "as") {
    const rawValue = fragment.value;
    const value = rawValue && rawValue.length > 0
      ? rawValue.toLowerCase()
      : DEFAULT_AS_VALUE;
    const label = AS_LABELS[value] || value;
    return `show results as ${label}`;
  }
  if (fragment.field === "sort") {
    if (!fragment.value) return "sort results";
    return `sort by ${formatSortValue(fragment.value)}`;
  }
  return null;
}

function describeOperator(field, operator, value, valueType, negated) {
  const formattedValue = formatValue(field, value, valueType);
  const textField = TEXT_FIELDS.has(field) || field === "artist" || field === "timing";

  if (valueType === "regex") {
    return negated ? `does not match ${formattedValue}` : `matches ${formattedValue}`;
  }

  if (operator === ">") {
    return negated ? `is not greater than ${formattedValue}` : `is greater than ${formattedValue}`;
  }
  if (operator === "<") {
    return negated ? `is not less than ${formattedValue}` : `is less than ${formattedValue}`;
  }
  if (operator === ">=") {
    return negated ? `is not ${formattedValue} or greater` : `is ${formattedValue} or greater`;
  }
  if (operator === "<=") {
    return negated ? `is not ${formattedValue} or less` : `is ${formattedValue} or less`;
  }
  if (operator === "=") {
    return negated ? `is not ${formattedValue}` : `is ${formattedValue}`;
  }
  if (textField) {
    return negated ? `does not contain ${formattedValue}` : `contains ${formattedValue}`;
  }
  return negated ? `is not ${formattedValue}` : `is ${formattedValue}`;
}

function describeFragment(fragment) {
  if (fragment.invalid || !fragment.field) {
    return null;
  }
  if (DIRECTIVE_FIELDS.has(fragment.field)) {
    return describeDirective(fragment);
  }
  // Boolean fields produce a complete clause (e.g. "is a headliner", "has errata").
  if (BOOLEAN_FIELDS.has(fragment.field)) {
    return describeBoolean(fragment.field, fragment.value, fragment.valueType, fragment.negated);
  }
  const label = formatFieldLabel(fragment.field);
  return `${label} ${describeOperator(fragment.field, fragment.operator, fragment.value, fragment.valueType, fragment.negated)}`;
}

function formatConjunctiveList(values) {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function formatInvalidKeywords(invalidKeywords) {
  const keywords = invalidKeywords.map((keyword) => `'${keyword}'`);
  if (keywords.length === 1) {
    return `${keywords[0]} is not a valid search term`;
  }
  return `${formatConjunctiveList(keywords)} are not valid search terms`;
}

function capitalizeFirst(text) {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

export function summarizeQuery(ast) {
  if (!ast || !ast.groups) return "";

  const invalidKeywords = [];
  const groupDescriptions = [];
  const directiveDescriptions = [];

  for (const group of ast.groups) {
    const fragmentDescriptions = [];
    for (const fragment of group.fragments) {
      if (fragment.invalid && fragment.rawKeyword) {
        invalidKeywords.push(fragment.rawKeyword);
        continue;
      }
      if (DIRECTIVE_FIELDS.has(fragment.field)) {
        const description = describeFragment(fragment);
        if (description) {
          directiveDescriptions.push(description);
        }
        continue;
      }
      const description = describeFragment(fragment);
      if (description) {
        fragmentDescriptions.push(description);
      }
    }
    if (fragmentDescriptions.length > 0) {
      groupDescriptions.push(formatConjunctiveList(fragmentDescriptions));
    }
  }

  const baseDescription = groupDescriptions.join(" or ");
  const validParts = [];
  if (groupDescriptions.length > 0) validParts.push(baseDescription);
  validParts.push(...directiveDescriptions);
  const validDescription = capitalizeFirst(formatConjunctiveList(validParts));
  const invalidDescription = invalidKeywords.length > 0
    ? `(${formatInvalidKeywords(invalidKeywords)})`
    : "";

  if (!validDescription) {
    if (!invalidDescription) return "";
    return `All terms ignored ${invalidDescription}`;
  }

  return invalidDescription ? `${validDescription} ${invalidDescription}` : validDescription;
}

export { KEYWORD_MAP, PRINTING_FIELDS, NUMERIC_FIELDS, DIRECTIVE_FIELDS, RARITY_ALIASES, RARITY_NAMES, RARITY_ORDER, normalizeRarityLabel, parseBooleanValue };
