function printAPIError({
  name,
  error,
}) {
  console.error(`============ API ERROR: ${name}\n`, error);
}

function printError({
  message,
  error,
}) {
  console.error(`============ ${message}\n`, error);
}

module.exports = {
  printAPIError,
  printError,
};
