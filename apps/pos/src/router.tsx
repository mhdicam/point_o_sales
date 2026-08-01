/**
 * Router — the app's route table (React Router).
 *
 *   /login          public — email/password → tenant-less token
 *   /select-scope   public-ish — needs a token, picks the tenant/outlet scope
 *   /admin/*        guarded by RequireScope; the master-data screens
 *
 * Screens are lazy-loaded so the login/scope path stays a small first bundle and
 * the heavier product editor + virtual list load only once inside /admin.
 */

import { lazy, Suspense } from 'react'
import type { ReactNode } from 'react'
import { createBrowserRouter, Navigate } from 'react-router-dom'
import type { RouterProviderProps } from 'react-router-dom'
import { RequireScope } from './routes/RequireScope.tsx'
import { AdminLayout } from './routes/AdminLayout.tsx'
import { LoginScreen } from './routes/LoginScreen.tsx'
import { SelectScopeScreen } from './routes/SelectScopeScreen.tsx'
import { Spinner } from './ui/primitives.tsx'

const ProductsScreen = lazy(() =>
  import('./routes/products/ProductsScreen.tsx').then((m) => ({ default: m.ProductsScreen }))
)
const CategoriesScreen = lazy(() =>
  import('./routes/CategoriesScreen.tsx').then((m) => ({ default: m.CategoriesScreen }))
)
const UnitsScreen = lazy(() =>
  import('./routes/UnitsScreen.tsx').then((m) => ({ default: m.UnitsScreen }))
)
const ModifiersScreen = lazy(() =>
  import('./routes/ModifiersScreen.tsx').then((m) => ({ default: m.ModifiersScreen }))
)
const PriceListsScreen = lazy(() =>
  import('./routes/PriceListsScreen.tsx').then((m) => ({ default: m.PriceListsScreen }))
)

function Lazy({ children }: { children: ReactNode }): ReactNode {
  return <Suspense fallback={<Spinner />}>{children}</Suspense>
}

export const router: RouterProviderProps['router'] = createBrowserRouter([
  { path: '/login', element: <LoginScreen /> },
  { path: '/select-scope', element: <SelectScopeScreen /> },
  {
    path: '/admin',
    element: <RequireScope />,
    children: [
      { element: <AdminLayout />, children: [
        { index: true, element: <Navigate to="products" replace /> },
        { path: 'products', element: <Lazy><ProductsScreen /></Lazy> },
        { path: 'categories', element: <Lazy><CategoriesScreen /></Lazy> },
        { path: 'units', element: <Lazy><UnitsScreen /></Lazy> },
        { path: 'modifiers', element: <Lazy><ModifiersScreen /></Lazy> },
        { path: 'prices', element: <Lazy><PriceListsScreen /></Lazy> },
      ] },
    ],
  },
  { path: '*', element: <Navigate to="/admin" replace /> },
])
