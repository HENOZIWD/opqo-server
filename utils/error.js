const ERROR_400 = 'BAD_REQUEST';
const ERROR_401 = 'UNAUTHORIZED';
const ERROR_403 = 'FORBIDDEN';
const ERROR_404 = 'NOT_FOUND';

function handleError({
  apiName,
  error,
  res,
  printError = true,
}) {
  if (printError) {
    console.log(`============ API ${apiName} error:\n`, error);
  }

  if (error.message === ERROR_400) {
    return res.status(400).end();
  }

  if (error.message === ERROR_401) {
    return res.status(401).end();
  }

  if (error.message === ERROR_403) {
    return res.status(403).end();
  }

  if (error.message === ERROR_404) {
    return res.status(404).end();
  }

  return res.status(500).end();
}

module.exports = {
  ERROR_400,
  ERROR_401,
  ERROR_403,
  ERROR_404,
  handleError,
};
