import { test, expect, type Page } from '@playwright/test'
import { loginAs, mockProviderModels } from './helpers/auth'

/**
 * Open Settings dialog and navigate to the Contacts section.
 */
async function openContactsSettings(page: Page) {
  await page.locator('button:has(.lucide-settings-2)').click()
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })

  await page.getByRole('dialog').getByText('Contacts', { exact: true }).click()
  await expect(
    page.getByText('Manage the shared contact registry accessible by all Kins.'),
  ).toBeVisible({ timeout: 5_000 })
}

/**
 * Open the "Add contact" dialog from within the Contacts settings.
 */
async function openAddContactDialog(page: Page) {
  await page.getByRole('button', { name: /add contact/i }).first().click()
  await expect(page.getByText('Create a new contact entry')).toBeVisible({ timeout: 5_000 })
}

/**
 * Create a contact via the form dialog.
 */
async function createContact(
  page: Page,
  opts: {
    firstName?: string
    lastName?: string
    nicknames?: string[]
    identifiers?: Array<{ label: string; value: string }>
  },
) {
  await openAddContactDialog(page)

  if (opts.firstName) {
    await page.locator('#contact-first-name').fill(opts.firstName)
  }
  if (opts.lastName) {
    await page.locator('#contact-last-name').fill(opts.lastName)
  }

  if (opts.nicknames?.length) {
    for (const nick of opts.nicknames) {
      await page.getByRole('button', { name: /add nickname/i }).click()
      const inputs = page.getByPlaceholder(/handle.*pseudonym|pseudo.*alias|spitzname|apodo/i)
      await inputs.last().fill(nick)
    }
  }

  // Add identifiers
  if (opts.identifiers) {
    for (const ident of opts.identifiers) {
      await page.getByRole('button', { name: /add field|add identifier|añadir campo|feld hinzufügen|ajouter un champ/i }).click()

      // The last combobox is the label selector for the new identifier
      const comboboxes = page.getByRole('combobox')
      const lastCombobox = comboboxes.last()
      await lastCombobox.click()

      // Type into the search input inside the popover
      const searchInput = page.getByPlaceholder('Type or search...')
      if (await searchInput.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await searchInput.fill(ident.label)
        // Click the matching suggestion
        const suggestion = page
          .locator('button')
          .filter({ hasText: new RegExp(`^${ident.label}$`, 'i') })
          .first()
        if (await suggestion.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await suggestion.click()
        } else {
          await searchInput.press('Enter')
        }
      }

      // Fill the value in the last value input
      const valueInputs = page.getByPlaceholder('Enter value')
      await valueInputs.last().fill(ident.value)
    }
  }

  // Submit — the "Add contact" button in the dialog footer
  // The dialog has a footer with Cancel + Add contact buttons
  const dialogs = page.locator('[role="dialog"]')
  const contactDialog = dialogs.last()
  await contactDialog.getByRole('button', { name: /add contact/i }).click()

  // Wait for dialog to close
  await expect(page.getByText('Create a new contact entry')).not.toBeVisible({ timeout: 5_000 })
}

/**
 * Delete a contact card by its name text, confirming in the AlertDialog.
 */
async function deleteContact(page: Page, name: string) {
  const card = page.locator('.surface-card', { hasText: name }).first()
  await card.locator('button:has(.lucide-trash-2)').first().click()

  // Confirm in the alert dialog
  await expect(page.getByText('This will permanently delete this contact')).toBeVisible({
    timeout: 3_000,
  })
  const alertDialog = page.locator('[role="alertdialog"]')
  await alertDialog.getByRole('button', { name: 'Delete' }).click()

  // Wait for the contact to disappear
  await expect(page.getByText(name)).not.toBeVisible({ timeout: 5_000 })
}

test.describe.serial('Contact management', () => {
  test.beforeEach(async ({ page }) => {
    await mockProviderModels(page)

    await page.goto('/')
    await expect(page.getByText('Sign in to your KinBot workspace')).toBeVisible({
      timeout: 10_000,
    })
    await loginAs(page)
    await expect(page.getByText('Kins', { exact: true })).toBeVisible({ timeout: 10_000 })
  })

  test('should navigate to contacts settings and see existing contacts', async ({ page }) => {
    await openContactsSettings(page)

    // Onboarding creates a "Test User" contact linked to the test account
    await expect(page.getByText('Test User').first()).toBeVisible({ timeout: 5_000 })
    // Should have the "Add contact" button
    await expect(page.getByRole('button', { name: /add contact/i })).toBeVisible()
  })

  test('should open add contact dialog and see form fields', async ({ page }) => {
    await openContactsSettings(page)
    await openAddContactDialog(page)

    await expect(page.locator('#contact-first-name')).toBeVisible()
    await expect(page.locator('#contact-last-name')).toBeVisible()
    await expect(page.getByText(/^Nicknames$/i)).toBeVisible()

    // Close dialog
    await page.keyboard.press('Escape')
  })

  test('should create a contact with first/last name and email field', async ({ page }) => {
    await openContactsSettings(page)

    await createContact(page, {
      firstName: 'Alice',
      lastName: 'Smith',
      identifiers: [{ label: 'email', value: 'alice@example.com' }],
    })

    await expect(page.getByText('Alice Smith')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('email: alice@example.com')).toBeVisible()
  })

  test('should create a second contact with only a nickname', async ({ page }) => {
    await openContactsSettings(page)

    await createContact(page, {
      nicknames: ['Bobby'],
    })

    await expect(page.getByText('Bobby')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByText('Alice Smith')).toBeVisible()
  })

  test('should edit a contact first name', async ({ page }) => {
    await openContactsSettings(page)
    await expect(page.getByText('Alice Smith')).toBeVisible({ timeout: 5_000 })

    const aliceCard = page.locator('.surface-card', { hasText: 'Alice Smith' }).first()
    await aliceCard.locator('button:has(.lucide-pencil)').first().click()

    await expect(page.getByText(/update contact information/i)).toBeVisible({ timeout: 5_000 })

    const firstNameInput = page.locator('#contact-first-name')
    await firstNameInput.clear()
    await firstNameInput.fill('Alicia')

    await page.getByRole('button', { name: /save/i }).click()

    await expect(page.getByText('Alicia Smith')).toBeVisible({ timeout: 5_000 })
  })

  test('should delete Bobby with confirmation', async ({ page }) => {
    await openContactsSettings(page)
    await expect(page.getByText('Bobby')).toBeVisible({ timeout: 5_000 })

    await deleteContact(page, 'Bobby')
  })

  test('should delete Alicia for cleanup', async ({ page }) => {
    await openContactsSettings(page)
    await expect(page.getByText('Alicia Smith')).toBeVisible({ timeout: 5_000 })

    await deleteContact(page, 'Alicia Smith')

    // Test User (from onboarding) should still be visible
    await expect(page.getByText('Test User').first()).toBeVisible({ timeout: 5_000 })
  })
})
