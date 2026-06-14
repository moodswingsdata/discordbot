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
  rulings: "rulings_text",
  rul: "rulings_text",
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
      field: "name",
      operator: ":",
      value: rawKeyword,
      valueType: "string",
      negated,
      error: `Unknown keyword "${rawKeyword}"`,
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

  // Collect any fragment-level errors
  for (const group of ast.groups) {
    for (const frag of group.fragments) {
      if (frag.error) {
        errors.push({ message: frag.error });
      }
    }
  }

  return { ast, errors };
}

export { KEYWORD_MAP, PRINTING_FIELDS, NUMERIC_FIELDS, DIRECTIVE_FIELDS };
