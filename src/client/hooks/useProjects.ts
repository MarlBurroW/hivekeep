import { useState, useEffect, useCallback } from 'react'
import { api } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import type { Project, ProjectSummary, ProjectTag, KinThinkingConfig } from '@/shared/types'

interface CreateProjectInput {
  title: string
  description?: string
  githubUrl?: string
  githubPatVaultKey?: string | null
  githubRepo?: string | null
  defaultBranch?: string
  model?: string | null
  providerId?: string | null
  thinkingConfig?: KinThinkingConfig | null
}

interface UpdateProjectInput {
  title?: string
  description?: string
  githubUrl?: string | null
  githubPatVaultKey?: string | null
  githubRepo?: string | null
  defaultBranch?: string
  model?: string | null
  providerId?: string | null
  thinkingConfig?: KinThinkingConfig | null
}

export function useProjects() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      const data = await api.get<{ projects: ProjectSummary[] }>('/projects')
      setProjects(data.projects)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refetch()
  }, [refetch])

  useSSE({
    'project:created': (data) => {
      const project = data.project as ProjectSummary
      setProjects((prev) => {
        if (prev.some((p) => p.id === project.id)) return prev
        return [...prev, project]
      })
    },
    'project:updated': (data) => {
      const project = data.project as ProjectSummary
      setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)))
    },
    'project:deleted': (data) => {
      const projectId = data.projectId as string
      setProjects((prev) => prev.filter((p) => p.id !== projectId))
    },
    'ticket:created': (data) => {
      const ticket = data.ticket as { projectId: string; status: string }
      // Bump the counts on the project
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== ticket.projectId) return p
          const isOpen = ticket.status !== 'done'
          return {
            ...p,
            ticketCount: p.ticketCount + 1,
            openTicketCount: p.openTicketCount + (isOpen ? 1 : 0),
          }
        }),
      )
    },
    'ticket:deleted': (data) => {
      const projectId = data.projectId as string
      // We don't know the old status here — refetch the project's summary lazily.
      // Cheap path: just refetch the list.
      refetch().catch(() => undefined)
      void projectId
    },
  })

  const createProject = useCallback(async (input: CreateProjectInput) => {
    const data = await api.post<{ project: Project }>('/projects', input)
    return data.project
  }, [])

  const updateProject = useCallback(async (id: string, input: UpdateProjectInput) => {
    const data = await api.patch<{ project: Project }>(`/projects/${id}`, input)
    return data.project
  }, [])

  const deleteProject = useCallback(async (id: string) => {
    await api.delete(`/projects/${id}`)
  }, [])

  return {
    projects,
    isLoading,
    refetch,
    createProject,
    updateProject,
    deleteProject,
  }
}

export function useProject(projectId: string | null) {
  const [project, setProject] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!projectId) {
      setProject(null)
      return
    }
    setIsLoading(true)
    try {
      const data = await api.get<{ project: Project }>(`/projects/${projectId}`)
      setProject(data.project)
    } catch {
      setProject(null)
    } finally {
      setIsLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    refetch()
  }, [refetch])

  useSSE({
    'project:updated': (data) => {
      const updated = data.project as ProjectSummary
      if (updated.id === projectId) {
        // Re-fetch full project (includes tags + ticket counts)
        refetch()
      }
    },
    'project:deleted': (data) => {
      if (data.projectId === projectId) setProject(null)
    },
    'project-tag:created': (data) => {
      if (data.projectId !== projectId) return
      const tag = data.tag as ProjectTag
      setProject((prev) => (prev ? { ...prev, tags: [...prev.tags, tag] } : prev))
    },
    'project-tag:updated': (data) => {
      if (data.projectId !== projectId) return
      const tag = data.tag as ProjectTag
      setProject((prev) =>
        prev ? { ...prev, tags: prev.tags.map((t) => (t.id === tag.id ? tag : t)) } : prev,
      )
    },
    'project-tag:deleted': (data) => {
      if (data.projectId !== projectId) return
      const tagId = data.tagId as string
      setProject((prev) =>
        prev ? { ...prev, tags: prev.tags.filter((t) => t.id !== tagId) } : prev,
      )
    },
  })

  return { project, isLoading, refetch }
}
