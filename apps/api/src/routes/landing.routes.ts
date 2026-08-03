/**
 * Landing CMS admin routes — S9-02, design §17.1.
 *
 * The authenticated surface the POS admin uses to build the tenant's public
 * page. Every route is gated on LANDING_MANAGE (standard #5: backend is the
 * security boundary). Deliberately NOT feature-gated: an admin may draft the
 * page before enabling the `landingPage` feature; the public read (S9-03) is
 * what enforces the feature, so an unpublished draft can never leak regardless.
 *
 * Route order matters: `PUT /sections/order` is registered before
 * `/sections/:id`, or the `:id` param would swallow the literal "order".
 *
 * Per-type `content` is validated here (one schema per section type) so the
 * service persists already-valid JSON. CATALOG drives live catalog queries, so
 * its shape is pinned; the presentational types accept a free-form object.
 */

import { Router } from 'express'
import { z } from 'zod'
import type { BrewsyncClient, Prisma } from '@brewsync/db'
import { PERMISSIONS } from '@brewsync/shared'
import { LandingService } from '../services/landing.service.js'
import { createPermissionMiddleware } from '../middleware/permission.middleware.js'
import { badRequest } from '../http-error.js'

const uuid = z.string().uuid()

const sectionTypeSchema = z.enum([
  'HERO',
  'CATALOG',
  'ABOUT',
  'GALLERY',
  'CONTACT',
  'HOURS',
  'MAP',
  'CUSTOM',
])

/**
 * CATALOG feeds the public catalog query (S9-03), so its content is pinned to
 * the ids it may reference. Every other type is presentational — its content is
 * consumed only by the renderer, so a free-form object keeps the schema stable
 * as designs evolve. `{}` is always valid (a section can be added then filled).
 */
const catalogContentSchema = z
  .object({
    categoryIds: z.array(uuid).max(50).optional(),
    productIds: z.array(uuid).max(200).optional(),
  })
  .strict()

const freeformContentSchema = z.record(z.string(), z.unknown())

function contentSchemaFor(type: z.infer<typeof sectionTypeSchema>) {
  return type === 'CATALOG' ? catalogContentSchema : freeformContentSchema
}

const updateMetaSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  theme: z.record(z.string(), z.unknown()).nullable().optional(),
  orderingEnabled: z.boolean().optional(),
})

const addSectionSchema = z.object({
  type: sectionTypeSchema,
  title: z.string().max(120).nullable().optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  isVisible: z.boolean().optional(),
})

const updateSectionSchema = z.object({
  title: z.string().max(120).nullable().optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  isVisible: z.boolean().optional(),
})

const reorderSchema = z.object({
  order: z
    .array(z.object({ id: uuid, position: z.number().int().min(0) }))
    .min(1)
    .max(100),
})

function parseId(raw: unknown, label: string): string {
  const parsed = uuid.safeParse(raw)
  if (!parsed.success) throw badRequest('VALIDATION_ERROR', `${label} must be a uuid`)
  return parsed.data
}

export function createLandingRouter(db: BrewsyncClient): Router {
  const router = Router()
  const landing = new LandingService(db)
  const requirePermission = createPermissionMiddleware(db)

  router.use(requirePermission(PERMISSIONS.LANDING_MANAGE))

  // The tenant page + all sections (draft included), position-ordered. Lazily
  // provisions the page on first access.
  router.get('/', async (_req, res, next) => {
    try {
      res.json({ landing: await landing.get() })
    } catch (error) {
      next(error)
    }
  })

  router.put('/', async (req, res, next) => {
    try {
      const parsed = updateMetaSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid landing meta', parsed.error.issues)
      }
      const { theme, ...rest } = parsed.data
      const landingPage = await landing.updateMeta({
        ...rest,
        ...(theme !== undefined && { theme: (theme ?? null) as Prisma.InputJsonValue | null }),
      })
      res.json({ landing: landingPage })
    } catch (error) {
      next(error)
    }
  })

  router.post('/sections', async (req, res, next) => {
    try {
      const parsed = addSectionSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid section data', parsed.error.issues)
      }
      const content = contentSchemaFor(parsed.data.type).safeParse(parsed.data.content ?? {})
      if (!content.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid section content', content.error.issues)
      }
      const landingPage = await landing.addSection({
        type: parsed.data.type,
        title: parsed.data.title ?? null,
        content: content.data as Prisma.InputJsonValue,
        ...(parsed.data.isVisible !== undefined && { isVisible: parsed.data.isVisible }),
      })
      res.status(201).json({ landing: landingPage })
    } catch (error) {
      next(error)
    }
  })

  // Registered before `/sections/:id` so ":id" never captures "order".
  router.put('/sections/order', async (req, res, next) => {
    try {
      const parsed = reorderSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid reorder data', parsed.error.issues)
      }
      res.json({ landing: await landing.reorder(parsed.data.order) })
    } catch (error) {
      next(error)
    }
  })

  router.put('/sections/:id', async (req, res, next) => {
    try {
      const parsed = updateSectionSchema.safeParse(req.body)
      if (!parsed.success) {
        throw badRequest('VALIDATION_ERROR', 'Invalid section data', parsed.error.issues)
      }
      const id = parseId(req.params['id'], 'Section id')
      // Content validation is keyed on the persisted type, which the update body
      // cannot change — so re-derive it from the section before validating.
      let content: z.infer<typeof freeformContentSchema> | undefined
      if (parsed.data.content !== undefined) {
        const current = await landing.getSectionType(id)
        const checked = contentSchemaFor(current).safeParse(parsed.data.content)
        if (!checked.success) {
          throw badRequest('VALIDATION_ERROR', 'Invalid section content', checked.error.issues)
        }
        content = checked.data
      }
      const landingPage = await landing.updateSection(id, {
        ...(parsed.data.title !== undefined && { title: parsed.data.title }),
        ...(content !== undefined && { content: content as Prisma.InputJsonValue }),
        ...(parsed.data.isVisible !== undefined && { isVisible: parsed.data.isVisible }),
      })
      res.json({ landing: landingPage })
    } catch (error) {
      next(error)
    }
  })

  router.delete('/sections/:id', async (req, res, next) => {
    try {
      res.json({ landing: await landing.removeSection(parseId(req.params['id'], 'Section id')) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/publish', async (_req, res, next) => {
    try {
      res.json({ landing: await landing.publish() })
    } catch (error) {
      next(error)
    }
  })

  router.post('/unpublish', async (_req, res, next) => {
    try {
      res.json({ landing: await landing.unpublish() })
    } catch (error) {
      next(error)
    }
  })

  return router
}
