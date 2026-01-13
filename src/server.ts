require('dotenv').config()
import api from './api'

// const PORT = process.env.PORT || 8080
const PORT = process.env.PORT || 3001

const tenantMode = process.env.TENANT_MODE || 'multi';
console.log(`TENANT_MODE: ${tenantMode}`);

api.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})
