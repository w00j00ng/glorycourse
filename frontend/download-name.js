/** @param {number} value */
const twoDigits = (value) => String(value).padStart(2, '0');

/** @param {string} name @param {string} kind @param {Date} downloadedAt */
const filename = (name, kind, downloadedAt) => {
  const timestamp = [
    downloadedAt.getFullYear() % 100,
    downloadedAt.getMonth() + 1,
    downloadedAt.getDate(),
    downloadedAt.getHours(),
    downloadedAt.getMinutes(),
    downloadedAt.getSeconds(),
  ].map(twoDigits).join('');
  return `${name}_${kind}_${timestamp}.xlsx`;
};

/** @param {string} name @param {Date} [downloadedAt] */
export const templateFilename = (name, downloadedAt = new Date()) => filename(name, '양식', downloadedAt);
/** @param {string} name @param {Date} [downloadedAt] */
export const reportFilename = (name, downloadedAt = new Date()) => filename(name, '현황', downloadedAt);
