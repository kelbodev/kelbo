// MySQL/MariaDB come motore della sezione Database: offre la capacità "db-engine" con id "mysql"
const createMysqlEngine = require('./engine');

module.exports = function createDbMysql() {
  return { providers: { mysql: createMysqlEngine() } };
};
