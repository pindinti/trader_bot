export const INDICATOR_STYLES = Object.freeze({
  'sma-9': Object.freeze({ label: 'SMA 9', color: '#f3c969', lineWidth: 1 }),
  'sma-21': Object.freeze({ label: 'SMA 21', color: '#db8f55', lineWidth: 1 }),
  'sma-200': Object.freeze({ label: 'SMA 200', color: '#dd6673', lineWidth: 2 }),
  'ema-9': Object.freeze({ label: 'EMA 9', color: '#70d9d2', lineWidth: 1 }),
  'ema-21': Object.freeze({ label: 'EMA 21', color: '#5fa9ef', lineWidth: 1 }),
  'ema-200': Object.freeze({ label: 'EMA 200', color: '#ab83e8', lineWidth: 2 }),
  vwap: Object.freeze({ label: 'VWAP', color: '#d7ed62', lineWidth: 2 }),
});

export function buildIndicatorLegend(enabledKeys, seriesByKey) {
  return [...enabledKeys].map((key) => {
    const style = INDICATOR_STYLES[key];
    if (!style) throw new RangeError(`Unsupported indicator: ${key}`);
    const values = seriesByKey[key] ?? [];
    return {
      key,
      label: style.label,
      color: style.color,
      value: values.length && Number.isFinite(values.at(-1)?.value) ? values.at(-1).value : null,
    };
  });
}
