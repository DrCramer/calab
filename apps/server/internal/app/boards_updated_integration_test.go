//go:build integration

package app_test

import (
	"testing"
	"time"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// TestTaskUpdatedAtFollowsActivity: the list shows the task's last activity (Task.updated_at), so a
// comment must move it just like a field edit does.
func TestTaskUpdatedAtFollowsActivity(t *testing.T) {
	o, _, ws, _ := setupTeam(t)
	b := createBoard(t, o, ws.GetId(), &v1.CreateBoardRequest{Name: "Давность", Key: "AGE"}, 201)
	task := createTask(t, o, b.GetId(), &v1.CreateTaskRequest{Title: "давно не трогали"}, 201)
	at := func() time.Time { return getTask(t, o, task.GetId()).GetTask().GetUpdatedAt().AsTime() }
	before := at()

	time.Sleep(20 * time.Millisecond)
	send(t, o, task.GetRoomId(), "что по задаче?", uniq("c"))
	eventually(t, "a comment bumps updated_at", func() bool { return at().After(before) })

	mid := at()
	time.Sleep(20 * time.Millisecond)
	title := "переименована"
	patchTask(t, o, task.GetId(), &v1.UpdateTaskRequest{Title: &title}, 200)
	if !at().After(mid) {
		t.Fatal("a field edit must bump updated_at")
	}
}
