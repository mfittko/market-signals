// A coach reply may land after the editor moved on. It applies only while the component is mounted
// and the strategy (and scope list) it was requested for is still the one on screen.
export function replyIsCurrent(requestedFor: string, onScreen: string, mounted: boolean): boolean {
  return mounted && requestedFor === onScreen;
}
