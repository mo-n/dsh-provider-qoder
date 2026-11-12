# Preserve existing Qoder machine IDs

Changing a Qoder machine ID can change the device identity used for authorization. Preserve the ID bound to an existing browser grant and prefer the region's Qoder CLI identity file, then the shared DSH identity file, when resolving a new authorization. With neither file available, derive the ID using Qoder CLI 1.1.86's hardware inputs and algorithm, fall back to a random UUID when the probe cannot provide a usable input, and publish the result in DSH storage.
