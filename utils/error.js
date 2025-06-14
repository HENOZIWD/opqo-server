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

const ERROR_400 = 'BAD_REQUEST';
const ERROR_401 = 'UNAUTHORIZED';

module.exports = {
  printAPIError,
  printError,
  ERROR_400,
  ERROR_401,
};
