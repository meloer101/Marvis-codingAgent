/** Fahrenheit -> Celsius, rounded to one decimal. */
export function toCelsius(f) {
  return Math.round(((f - 32) * 5) / 9 * 10) / 10;
}
