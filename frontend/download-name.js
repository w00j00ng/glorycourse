const twoDigits = (value) => String(value).padStart(2, '0');

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

export const templateFilename = (name, downloadedAt = new Date()) => filename(name, '양식', downloadedAt);
export const reportFilename = (name, downloadedAt = new Date()) => filename(name, '현황', downloadedAt);
