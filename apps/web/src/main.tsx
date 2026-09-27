import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/globals.css'
import './styles/editorial.css'
import App from './App.tsx'
import { AuthProvider } from './lib/auth'
import { PageLoader } from './components/ui/PageLoader'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        {/* Safety net: the per-shell boundaries handle normal route
            transitions, this catches anything lazy mounted outside a shell. */}
        <Suspense fallback={<PageLoader />}>
          <App />
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
