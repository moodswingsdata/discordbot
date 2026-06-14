import { AutoRouter } from 'itty-router';
import {
  InteractionResponseType,
  InteractionType,
  verifyKey,
} from 'discord-interactions';
import { FEEL_COMMAND, SEARCH_COMMAND } from './commands.js';
import { InteractionResponseFlags } from 'discord-interactions';
import {
  fuzzyMatchCard,
  pickAnyCard,
  buildCardResponseData,
} from './cards.js';
import { parseQuery } from './parser.js';
import { initSearch, executeSearch } from './search.js';
import cardsData from './data/cards.json' with { type: 'json' };
import printingsData from './data/printings.json' with { type: 'json' };
import editionsData from './data/editions.json' with { type: 'json' };

initSearch(cardsData, printingsData, editionsData);

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
        if (!searchResult.match) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `Nothing matched "${cardSearch}".`,
            },
          });
        }
        const introText = searchResult.random
            ? `${userName} just wants to feel something. How about...`
            : `"${cardSearch}" found a match.`;
        return new JsonResponse({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildCardResponseData(introText, searchResult),
        });
      }
      case SEARCH_COMMAND.name.toLowerCase(): {
        const query = interaction.data.options ? interaction.data.options[0].value : "";
        if (!query) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: 'Please provide a search query.',
            },
          });
        }

        try {
          const { ast, errors: parseErrors } = parseQuery(query);
          const { results, directives, errors: searchErrors } = executeSearch(ast);
          const allErrors = [...parseErrors, ...searchErrors];

          if (results.length === 0) {
            const errorNote = allErrors.length > 0
              ? `\n⚠️ ${allErrors.map(e => e.message).join('; ')}`
              : '';
            return new JsonResponse({
              type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `No results for \`${query}\`.${errorNote}`,
              },
            });
          }

          const MAX_RESULTS = 10;
          const shown = results.slice(0, MAX_RESULTS);
          const lines = shown.map(({ card }) => {
            const color = card.color.length > 0 ? card.color.join(', ') : 'Colorless';
            const diceStr = card.dice
              ? (card.secondary_dice ? `${card.dice}/${card.secondary_dice}` : card.dice)
              : 'No dice';
            return `• **${card.name}** (${color}, ${diceStr})`;
          });

          let content = `Search: \`${query}\`\n` + lines.join('\n');
          if (results.length > MAX_RESULTS) {
            content += `\n\n_…and ${results.length - MAX_RESULTS} more result${results.length - MAX_RESULTS !== 1 ? 's' : ''}._`;
          }

          const searchUrl = new URL("https://moodswingsdata.github.io/feelings/");
          searchUrl.hash = `q=${encodeURIComponent(query)}`;
          content += `\n[View full results on the web](${searchUrl})`;

          if (allErrors.length > 0) {
            content += `\n⚠️ ${allErrors.map(e => e.message).join('; ')}`;
          }

          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content },
          });
        } catch (err) {
          return new JsonResponse({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `Search error: ${err.message}`,
            },
          });
        }
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
