require('dotenv').config()
import api from './api'

// const PORT = process.env.PORT || 8080
const PORT = 3001

api.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})
