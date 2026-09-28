import { applicationServices } from '../services/application.js';

/** Fetch a fixed, worldwide Dutch-language headline category via the proxy. */
export async function fetchNewsHeadlines(category, options) {
  if (!['world', 'politics', 'economy', 'crises'].includes(category))
    throw new TypeError('Choose world, politics, economy, or crises');
  return applicationServices.news.getHeadlines(category, options);
}
