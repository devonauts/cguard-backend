import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import bodyParser from 'body-parser'
import { createRateLimiter } from './apiRateLimiter'
import { databaseMiddleware } from '../middlewares/databaseMiddleware'
import { languageMiddleware } from '../middlewares/languageMiddleware'
import { authMiddleware } from '../middlewares/authMiddleware'
import authSocial from './auth/authSocial'
import setupSwaggerUI from './apiDocumentation'
import { tenantMiddleware } from '../middlewares/tenantMiddleware'

const app = express()

app.use(cors({ origin: true }))
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, crossOriginEmbedderPolicy: false }))
app.use(bodyParser.json({
  verify: (req: any, _res, buf) => {
    const url = req.originalUrl || ''
    if (url.startsWith('/api/plan/stripe/webhook')) req.rawBody = buf.toString()
  }
}))
app.use(databaseMiddleware)
app.use(languageMiddleware)
app.use(createRateLimiter({ max: 500, windowMs: 15 * 60 * 1000, message: 'errors.429' }))
setupSwaggerUI(app)

const routes = express.Router()
authSocial(app, routes)
require('./auditLog').default(routes)
require('./auth').default(routes)
require('./plan').default(routes)
require('./tenant').default(routes)
require('./file').default(routes)
require('./user').default(routes)
require('./settings').default(routes)
require('./dashboard').default(routes)
require('./bannerSuperiorApp').default(routes)
require('./service').default(routes)
require('./certification').default(routes)
require('./securityGuard').default(routes)
require('./clientAccount').default(routes)
require('./representanteEmpresa').default(routes)
require('./incident').default(routes)
require('./inventory').default(routes)
require('./additionalService').default(routes)
require('./patrolCheckpoint').default(routes)
require('./patrolLog').default(routes)
require('./patrol').default(routes)
require('./station').default(routes)
require('./billing').default(routes)
require('./inquiries').default(routes)
require('./task').default(routes)
require('./notification').default(routes)
require('./deviceIdInformation').default(routes)
require('./guardShift').default(routes)
require('./memos').default(routes)
require('./request').default(routes)
require('./videoTutorialCategory').default(routes)
require('./videoTutorial').default(routes)
require('./tutorial').default(routes)
require('./completionOfTutorial').default(routes)
require('./inventoryHistory').default(routes)
require('./businessInfo').default(routes)
require('./insurance').default(routes)
require('./notificationRecipient').default(routes)
require('./report').default(routes)
require('./shift').default(routes)

routes.param('tenantId', tenantMiddleware)
app.use('/api', routes)
app.use((req, res) => res.status(404).json({ message: 'Not Found' }))
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error('🔥 Unhandled error:', err)
  res.status(err.status || 500).json({ message: err.message || 'Error interno' })
})

export default app
