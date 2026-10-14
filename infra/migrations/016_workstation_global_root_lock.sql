-- Prevent registering the same physical repository under different OmnyaDesk projects.
-- Resource locks S10 must not be bypassed by a second project ID for the same root.
CREATE UNIQUE INDEX workstation_canonical_root_global_unique
 ON workstation_projects (lower(canonical_root));
