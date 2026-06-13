import { extract, token_set_ratio } from 'fuzzball/ultra_lite';
import cardData from './cards.json' with { type: 'json' };

export const cardNames = cardData.map((card) => card.name);
export const cardIndex = new Map(cardData.map((card) => [card.name, card]));

const fuzzOptions = {
    scorer: token_set_ratio,
    limit: 1,
    cutoff: 50,
};

// NOTE: this is NOT a general-purpose HTML unescaper. It depends on the quality
// of the data passed in from cards.json. For example, if there's a mismatched
// <strong> tag somewhere, this will happily give mismatched `**`s.
export function toMarkdown(cardText) {
    if (cardText) {
        return cardText
            .replaceAll("<strong>", "**").replaceAll("</strong>", "**")
            .replaceAll("<br/>", "\n")
            .replaceAll("<em>", "_").replaceAll("</em>", "_");
    }
}

export function formatCard(cardName) {
    const data = cardIndex.get(cardName);
    if (!data) { return "Something went wrong, unable to locate card."; }
    const color = data.color.length > 0 ? data.color.join(", ") : "Colorless";
    const diceStr = data.secondary_dice ? `${data.dice}/${data.secondary_dice}` : data.dice;
    return `**${cardName}** (${color}, ${diceStr})\n\n${toMarkdown(data.rules_text) ?? "_(Vanilla, no rules text)_"}`
}

const COLOR_ACCENTS = {
    'White': 0xFFF9EA,
    'Blue':  0x1E72B8,
    'Black': 0x3D1F5C,
    'Red':   0xCC2200,
    'Green': 0x1C7A3D,
};
const COLORLESS_ACCENT = 0x9B9B9B;
const GOLD_ACCENT = 0xD4AF37;

export function cardAccentColor(cardName) {
    const data = cardIndex.get(cardName);
    if (!data) {
        console.error(`cardAccentColor: no card data found for "${cardName}"`);
        return COLORLESS_ACCENT;
    }
    const colors = data.color;
    if (colors.length === 0) return COLORLESS_ACCENT;
    if (colors.length > 1) return GOLD_ACCENT;
    return COLOR_ACCENTS[colors[0]] ?? COLORLESS_ACCENT;
}

export function pickAnyCard() {
    return {
        match: true,
        random: true,
        cardName: cardNames[Math.floor(Math.random() * cardNames.length)],
    };
}

export function fuzzyMatchCard(input) {
    const result = extract(input, cardNames, fuzzOptions);
    return (result.length > 0)
        ? { cardName: result[0][0], match: true, random: false }
        : { match: false };
}

export const COMPONENT_TYPE_CONTAINER = 17;
export const COMPONENT_TYPE_TEXT_DISPLAY = 10;
export const IS_COMPONENTS_V2 = 1 << 15;

export function buildCardResponseData(introText, searchResult) {
    const cardText = formatCard(searchResult.cardName);
    return {
        flags: IS_COMPONENTS_V2,
        components: [{
            type: COMPONENT_TYPE_CONTAINER,
            accent_color: cardAccentColor(searchResult.cardName),
            components: [
                { type: COMPONENT_TYPE_TEXT_DISPLAY, content: introText },
                { type: COMPONENT_TYPE_TEXT_DISPLAY, content: cardText },
            ],
        }],
    };
}
