/**
 * Router — the customer QR ordering app's route table (React Router).
 *
 *   /t/:token          the table's menu (resolve token → menu → cart → checkout)
 *   /t/:token/confirm  post-order confirmation (server totals)
 *   *                  opaque not-found (an invalid path is treated like a bad QR)
 *
 * Every route is PUBLIC — there is no auth gate, by design (§16.2): the security
 * boundary lives entirely in the backend token resolve, not the client. The menu
 * screen is the first bundle; the rest are small enough to load eagerly.
 */

import { createBrowserRouter, Navigate } from 'react-router-dom'
import type { RouterProviderProps } from 'react-router-dom'
import { MenuScreen } from './routes/MenuScreen.tsx'
import { ConfirmScreen } from './routes/ConfirmScreen.tsx'
import { NotFoundScreen } from './routes/NotFoundScreen.tsx'

export const router: RouterProviderProps['router'] = createBrowserRouter([
  { path: '/t/:token', element: <MenuScreen /> },
  { path: '/t/:token/confirm', element: <ConfirmScreen /> },
  // A bare visit with no table token has nothing to show; treat as not-found.
  { path: '/', element: <NotFoundScreen /> },
  { path: '*', element: <Navigate to="/" replace /> },
])
