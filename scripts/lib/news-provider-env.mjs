// One env for EVERY news provider, resolved settings-first.
//
// Each provider ships its own settings→env resolver returning only its own keys.
// A call site that reaches for a single provider's resolver silently disables
// every other provider — which is how a key configured in the settings dialog
// ends up doing nothing on the watcher path, with no error to notice. Callers use
// this instead of a per-provider resolver, so adding the next provider is one
// edit here rather than a hunt through every call site.
import { resolveNewsApiAiSource } from './newsapi-ai-source.mjs';
import { resolveGnewsSource } from './gnews-source.mjs';

export function resolveNewsProviderEnv(settings = {}, env = process.env) {
  return { ...resolveNewsApiAiSource(settings, env), ...resolveGnewsSource(settings, env) };
}
