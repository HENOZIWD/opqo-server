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
const ERROR_403 = 'FORBIDDEN';
const ERROR_404 = 'NOT_FOUND';

module.exports = {
  printAPIError,
  printError,
  ERROR_400,
  ERROR_401,
  ERROR_403,
  ERROR_404,
};
