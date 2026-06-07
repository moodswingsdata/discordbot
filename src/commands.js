export const FEEL_COMMAND = {
  name: 'feel',
  description: 'Look up a card by name.',
  options: [
    {
      name: 'card',
      description: 'Card name',
      type: 3, // 3 = string
      max_length: 100,
    },
  ],
};

export const SEARCH_COMMAND = {
  name: 'search',
  description: 'Run a search using Feelings syntax.',
  options: [
    {
      name: 'query',
      description: 'Search query',
      type: 3, // 3 = string
      max_length: 100,
    },
  ],
};
