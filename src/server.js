import { AutoRouter } from 'itty-router';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { FEEL_COMMAND, SEARCH_COMMAND } from './commands.js';
import { InteractionResponseFlags } from 'discord-interactions';
import { extract, token_set_ratio } from 'fuzzball/ultra_lite';

class JsonResponse extends Response {
  constructor(body, init) {
    const jsonBody = JSON.stringify(body);
    init = init || {
      headers: {
        'content-type': 'application/json;charset=UTF-8',
      },
    };
    super(jsonBody, init);
  }
}

// NOTE: this is NOT a general-purpose HTML unescaper. It depends on the quality
// of the data passed in from cards.json. For example, if there's a mismatched
// <strong> tag somewhere, this will happily give mismatched `**`s.
function toMarkdown(cardText) {
    if (cardText) {
        return cardText
            .replaceAll("<strong>", "**").replaceAll("</strong>", "**")
            .replaceAll("<br/>", "\n")
            .replaceAll("<em>", "_").replaceAll("</em>", "_");
    }
}

const fuzzOptions = {
    scorer: token_set_ratio,
    limit: 1,
    cutoff: 50,
};
import cardData from './cards.json';
const cardNames = cardData.map((card) => card.name);
const cardIndex = new Map(cardData.map((card) => [card.name, card]));

function formatCard(cardName) {
    const data = cardIndex.get(cardName);
    if (!data) { return "Something went wrong, unable to locate card."; }
    const color = data.color.length > 0 ? data.color.join(", ") : "Colorless";
    const diceStr = data.secondary_dice ? `${data.dice}/${data.secondary_dice}` : data.dice;
    return `**${cardName}** (${color}, ${diceStr})\n\n${toMarkdown(data.rules_text)}`
}

function pickAnyCard() {
    return {
        match: true,
        random: true,
        cardName: cardNames[Math.floor(Math.random() * cardNames.length)],
    };
}

function fuzzyMatchCard(input) {
    const result = extract(input, cardNames, fuzzOptions);
    // console.log(result);
    return (result.length > 0)
        ? { cardName: result[0][0], match: true, random: false }
        : { match: false };
}

const router = AutoRouter();

/**
 * A simple :wave: hello page to verify the worker is working.
 */
router.get('/', (request, env) => {
  return new Response(`👋 ${env.DISCORD_APP_ID}`);
});

/**
 * Main route for all requests sent from Discord.  All incoming messages will
 * include a JSON payload described here:
 * https://discord.com/developers/docs/interactions/receiving-and-responding#interaction-object
 */
router.post('/', async (request, env) => {
  const { isValid, interaction } = await server.verifyDiscordRequest(
    request,
    env,
  );
  if (!isValid || !interaction) {
    return new Response('Bad request signature.', { status: 401 });
  }

  if (interaction.type === InteractionType.PING) {
    // The `PING` message is used during the initial webhook handshake, and is
    // required to configure the webhook in the developer portal.
    return new JsonResponse({
      type: InteractionResponseType.PONG,
    });
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    // Most user commands will come as `APPLICATION_COMMAND`.
    switch (interaction.data.name.toLowerCase()) {
      case FEEL_COMMAND.name.toLowerCase(): {
        // I read somewhere that DMs put this on .user but channel messages put it on .member.user
        const user = interaction.user ?? interaction.member.user;
        const userName = user.global_name ?? user.username;
        const cardSearch = interaction.data.options ? interaction.data.options[0].value : "";
        const searchResult = cardSearch.length > 0 ? fuzzyMatchCard(cardSearch) : pickAnyCard();
        const reply = searchResult.match
            ? (searchResult.random
                ? `${userName} just wants to feel something. How about...\n\n${formatCard(searchResult.cardName)}`
                : `"${cardSearch}" found a match.\n\n${formatCard(searchResult.cardName)}`)
            : `Nothing matched "${cardSearch}".`;
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: reply,
          },
        });
      }
      case SEARCH_COMMAND.name.toLowerCase(): {
        const applicationId = env.DISCORD_APP_ID;
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Search is not online yet.",
            flags: InteractionResponseFlags.EPHEMERAL,
          },
        });
      }
      default:
        return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
    }
  }

  console.error('Unknown Type');
  return new JsonResponse({ error: 'Unknown Type' }, { status: 400 });
});
router.all('*', () => new Response('Not Found.', { status: 404 }));

async function verifyDiscordRequest(request, env) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  const body = await request.text();
  const isValidRequest =
    signature &&
    timestamp &&
    (await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY));
  if (!isValidRequest) {
    return { isValid: false };
  }

  return { interaction: JSON.parse(body), isValid: true };
}

const server = {
  verifyDiscordRequest,
  fetch: router.fetch,
};

export default server;
