// The first open of the stream loads nothing extra. Every later open refetches both the run state and the news card.
export function refetchOnOpen(alreadyOpened: boolean): { tick: boolean; news: boolean } {
  return { tick: alreadyOpened, news: alreadyOpened };
}
