function checkAdminPassword() {
const correct = "admin123"; 
const input = document.getElementById("adminPass").value;


if (input === correct) {
document.getElementById("admin-login-wrapper").style.display = "none";
document.getElementById("admin-panel").style.display = "block";
} else {
document.getElementById("login-error").style.display = "block";
}
}