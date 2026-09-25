export const nextSemesterOrder = (items: readonly { order: number | null }[]): number => {
  const current = items.reduce((maximum, item) => Math.max(maximum, item.order ?? 0), 0);
  const next = current + 1;
  if (!Number.isSafeInteger(next)) throw new RangeError('No semester order is available');
  return next;
};
